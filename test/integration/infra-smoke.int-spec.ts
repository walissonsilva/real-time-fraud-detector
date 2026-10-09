import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';
import { FraudAlert } from '../../src/alerts/fraud-alert';
import { AlertRepository } from '../../src/alerts/alert.repository';

const contracts = join(__dirname, '../../docs/contratos');
const readJson = (rel: string) => JSON.parse(readFileSync(join(contracts, rel), 'utf8'));

describe('infra smoke: SQS real + Postgres real (requer infra:up e migrate)', () => {
  const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repo = new AlertRepository(pool);
  const runId = randomUUID();
  const alertIds: string[] = [];

  // Sem purge, mensagens de execuções anteriores (VisibilityTimeout 10 s) fazem o consumo varrer a fila por ~2 min.
  beforeAll(async () => {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'transactions' }));
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
  });

  afterAll(async () => {
    if (alertIds.length) {
      await pool.query('DELETE FROM outbox WHERE alert_id = ANY($1::uuid[])', [alertIds]);
      await pool.query('DELETE FROM alerts WHERE alert_id = ANY($1::uuid[])', [alertIds]);
    }
    await pool.end();
    sqs.destroy();
  });

  it('a topologia criada pelo LocalStack existe', async () => {
    for (const name of [
      'transactions',
      'transactions-dlq',
      'alert-deliveries-antifraud-queue.fifo',
      'alert-deliveries-customer-push.fifo',
    ]) {
      const res = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      expect(res.QueueUrl).toContain(name);
    }
  });

  it('publica um TransactionEvent válido e o consome com SentTimestamp', async () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(readJson('transaction-event.v1.schema.json'));

    const event = {
      ...readJson('examples/transaction-event.authorized.valid.json'),
      eventId: randomUUID(),
      transactionId: `tx-int-${runId}`,
    };
    expect(validate(event)).toBe(true);

    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'transactions' }));
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const before = Date.now();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(event),
        MessageAttributes: {
          accountId: { DataType: 'String', StringValue: event.accountId },
          'schema-version': { DataType: 'String', StringValue: event.schemaVersion },
          traceparent: { DataType: 'String', StringValue: traceparent },
        },
      }),
    );

    // Consome só a mensagem desta execução; as demais voltam à fila imediatamente.
    let found: { body: Record<string, unknown>; sent: number; attrs: Record<string, string> } | undefined;
    for (let i = 0; i < 10 && !found; i++) {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ['SentTimestamp'],
          MessageAttributeNames: ['All'],
        }),
      );
      for (const m of res.Messages ?? []) {
        const body = JSON.parse(m.Body!);
        if (body.transactionId === event.transactionId) {
          found = {
            body,
            sent: Number(m.Attributes!.SentTimestamp),
            attrs: Object.fromEntries(
              Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue!]),
            ),
          };
          await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle! }));
        } else {
          await sqs.send(
            new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 }),
          );
        }
      }
    }

    expect(found).toBeDefined();
    expect(found!.body).toEqual(event);
    expect(found!.attrs).toEqual({
      accountId: event.accountId,
      'schema-version': '1.0',
      traceparent,
    });
    expect(found!.sent).toBeGreaterThanOrEqual(before - 1000);
    expect(found!.sent).toBeLessThanOrEqual(Date.now());
  });

  it('grava alerta + outbox atomicamente e rejeita duplicata por dedupeKey', async () => {
    const base = readJson('examples/fraud-alert.valid.json');
    const alert = {
      ...base,
      alertId: randomUUID(),
      dedupeKey: `int-${runId}`,
      transactionId: `tx-int-${runId}`,
    } as FraudAlert;
    alertIds.push(alert.alertId);

    expect(await repo.saveWithOutbox(alert)).toBe(true);

    const duplicate = { ...alert, alertId: randomUUID() } as FraudAlert;
    alertIds.push(duplicate.alertId);
    expect(await repo.saveWithOutbox(duplicate)).toBe(false);

    const alerts = await pool.query('SELECT alert_id FROM alerts WHERE dedupe_key = $1', [alert.dedupeKey]);
    expect(alerts.rows).toHaveLength(1);
    const outbox = await pool.query('SELECT published_at FROM outbox WHERE alert_id = ANY($1::uuid[])', [alertIds]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].published_at).toBeNull();

    await repo.markPublished(alert.alertId, new Date());
    const after = await pool.query(
      'SELECT o.published_at AS o, a.published_at AS a FROM outbox o JOIN alerts a USING (alert_id) WHERE o.alert_id = $1',
      [alert.alertId],
    );
    expect(after.rows[0].o).not.toBeNull();
    expect(after.rows[0].a).not.toBeNull();
  });
});
