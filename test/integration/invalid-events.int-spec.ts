import { randomUUID } from 'node:crypto';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { ProcessTransaction } from '../../src/application/use-cases/process-transaction';
import { RejectInvalidEvent } from '../../src/application/use-cases/reject-invalid-event';
import { AppConfig, loadConfig } from '../../src/infrastructure/config/config.module';
import { AjvTransactionEventValidator } from '../../src/infrastructure/contracts/ajv-transaction-event.validator';
import { SqsDlqPublisher } from '../../src/infrastructure/messaging/sqs-dlq.publisher';
import { SqsTransactionConsumer } from '../../src/infrastructure/messaging/sqs-transaction.consumer';
import { JsonLogger } from '../../src/infrastructure/observability/logger';
import { InMemoryMetrics } from '../../src/infrastructure/observability/metrics';
import { drain, newPool, newSqs, purge, readExample } from './support';

/** Texto do original: objeto serializado ou base64 decodificado. */
const originalText = (m: Record<string, unknown>) => {
  const o = m.original as { encoding: string; payload: unknown };
  return o.encoding === 'base64' ? Buffer.from(o.payload as string, 'base64').toString('utf8') : JSON.stringify(o.payload);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('eventos inválidos → DLQ (requer infra:up e migrate)', () => {
  const runId = randomUUID().slice(0, 8);
  const sqs = newSqs();
  const pool: Pool = newPool();
  const logs: string[] = [];
  const logger = new JsonLogger((line) => logs.push(line));
  const metrics = new InMemoryMetrics();
  let config: AppConfig;
  let consumer: SqsTransactionConsumer;
  let queueUrl: string;
  const processor = { execute: jest.fn() };

  const send = (body: string) => sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));

  const inputEmpty = async () => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
    );
    return Attributes!.ApproximateNumberOfMessages === '0' && Attributes!.ApproximateNumberOfMessagesNotVisible === '0';
  };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://fraud:fraud@localhost:55432/fraud';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    config = loadConfig();
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: config.queues.transactions }))).QueueUrl!;
    await purge(sqs, [config.queues.transactions, config.queues.transactionsDlq]);
    const reject = new RejectInvalidEvent({
      dlq: new SqsDlqPublisher(sqs),
      dlqQueue: config.queues.transactionsDlq,
      source: config.queues.transactions,
      logger,
      metrics,
    });
    consumer = new SqsTransactionConsumer(
      sqs,
      config,
      new AjvTransactionEventValidator(),
      processor as unknown as ProcessTransaction,
      reject,
      new SqsDlqPublisher(sqs),
      logger,
      metrics,
    );
    await consumer.start(1);
  });

  afterAll(async () => {
    await consumer.stop();
    await pool.end();
    sqs.destroy();
  });

  it('cenário 6: cada defeito vai à DLQ com motivo e original; nada é avaliado; entrada esvazia; logs sem PII', async () => {
    const valid = readExample('transaction-event.authorized.valid.json');
    const ip = '203.0.113.77';
    const tag = (n: string) => `tx-inv-${runId}-${n}`;
    const cases: { name: string; body: string; reasonCode: string }[] = [
      { name: 'missing', body: JSON.stringify({ ...valid, transactionId: tag('missing'), accountId: undefined }), reasonCode: 'SCHEMA_INVALID' },
      { name: 'negative', body: JSON.stringify({ ...valid, transactionId: tag('negative'), amount: { minorUnits: -5, currency: 'BRL' } }), reasonCode: 'SCHEMA_INVALID' },
      { name: 'wrongtype', body: JSON.stringify({ ...valid, transactionId: tag('wrongtype'), amount: 'muito' }), reasonCode: 'SCHEMA_INVALID' },
      { name: 'pii', body: JSON.stringify({ ...valid, transactionId: tag('pii'), cpf: '123.456.789-09', ipLeak: ip }), reasonCode: 'SCHEMA_INVALID' },
      { name: 'v2', body: JSON.stringify({ ...valid, transactionId: tag('v2'), schemaVersion: '2.0' }), reasonCode: 'UNSUPPORTED_VERSION' },
      { name: 'truncated', body: `{"transactionId":"${tag('truncated')}","ipAddress":"${ip}"`, reasonCode: 'DESERIALIZATION_ERROR' },
    ];
    for (const c of cases) await send(c.body);

    const found = await drain(sqs, config.queues.transactionsDlq, (b) => originalText(b).includes(`tx-inv-${runId}`), {
      wantAtLeast: cases.length,
      rounds: 15,
    });
    expect(found).toHaveLength(cases.length);

    for (const c of cases) {
      const msg = found.find((m) => originalText(m).includes(tag(c.name)))!;
      expect(msg).toMatchObject({ stage: 'INGEST_VALIDATION', reasonCode: c.reasonCode });
      expect(typeof msg.reasonDetail).toBe('string');
      const restored = originalText(msg);
      expect(restored).toContain(tag(c.name));
    }

    // nada avaliado, entrada esvaziada
    expect(processor.execute).not.toHaveBeenCalled();
    for (let i = 0; i < 20 && !(await inputEmpty()); i++) await sleep(250);
    expect(await inputEmpty()).toBe(true);

    // nenhum alerta/outbox para essas transações
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM alerts WHERE transaction_id LIKE $1', [`tx-inv-${runId}-%`]);
    expect(rows[0].n).toBe(0);

    // SC-007: logs sem conteúdo do evento
    const all = logs.join('\n');
    expect(all).toContain('evento inválido rejeitado');
    expect(all).not.toContain(ip);
    expect(all).not.toContain('123.456.789-09');
    expect(all).not.toContain(`tx-inv-${runId}`);
    expect(metrics.counter('events_rejected_total', { reason: 'SCHEMA_INVALID' })).toBe(4);
  });
});
