import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { deliveryIdOf } from '../../src/domain/alert/delivery-id';
import { CHANNEL_FAULTS, ChannelFaults } from '../../src/infrastructure/messaging/messaging.module';
import { drain, newPool, newSqs, purge, readExample } from './support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condição não satisfeita a tempo');
    await sleep(250);
  }
}

describe('propagação do traceId (FR-029) (requer infra:up e migrate)', () => {
  const runId = randomUUID().slice(0, 8);
  const sqs = newSqs();
  const pool: Pool = newPool();
  let app: INestApplication;
  let queueUrl: string;
  let faults: ChannelFaults;
  const transactionIds: string[] = [];
  const logs: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://fraud:fraud@localhost:55432/fraud';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.RULES_CONFIG_PATH = 'config/rules.json';
    process.env.CHANNEL_DELIVERY_BASE_DELAY_MS = '20';
    process.env.CHANNEL_DELIVERY_MAX_DELAY_MS = '50';
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'transactions' }))).QueueUrl!;
    await purge(sqs, ['transactions', 'alert-deliveries-antifraud-queue.fifo', 'alert-deliveries-customer-push.fifo', 'alert-deliveries-antifraud-queue-dlq.fifo', 'alert-deliveries-customer-push-dlq.fifo']);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    faults = app.get<ChannelFaults>(CHANNEL_FAULTS);
  });

  afterAll(async () => {
    process.stdout.write = realWrite;
    await app.close();
    await pool.query('DELETE FROM deliveries WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
    await pool.query('DELETE FROM outbox WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
    await pool.query('DELETE FROM alerts WHERE transaction_id = ANY($1)', [transactionIds]);
    await pool.end();
    sqs.destroy();
  });

  async function sendTraced(failCustomer: boolean) {
    const traceId = randomBytes(16).toString('hex');
    const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;
    const event = {
      ...readExample('transaction-event.authorized.valid.json'),
      eventId: randomUUID(),
      transactionId: `tx-trace-${runId}-${randomUUID().slice(0, 6)}`,
      accountId: `acc-trace-${runId}`,
      amount: { minorUnits: 2_000_000, currency: 'BRL' },
      traceId,
    };
    transactionIds.push(event.transactionId);
    faults.customer = failCustomer;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event),
        MessageAttributes: { traceparent: { DataType: 'String', StringValue: traceparent } },
      }),
    );
    return { event, traceId, traceparent };
  }

  it('o traceId do evento chega ao alerta, ao outbox, às entregas e aos logs', async () => {
    const { event, traceId, traceparent } = await sendTraced(false);
    const row = await eventually(async () => {
      const { rows } = await pool.query(
        `SELECT a.alert_id, o.traceparent, o.payload FROM alerts a JOIN outbox o USING (alert_id)
          WHERE a.transaction_id = $1 AND o.published_at IS NOT NULL`,
        [event.transactionId],
      );
      return rows[0];
    });
    expect(row.traceparent).toBe(traceparent);
    expect(row.payload.traceId).toBe(traceId);

    await eventually(async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE alert_id = $1 AND status = $2', [row.alert_id, 'DELIVERED']);
      return rows[0].n === 2;
    });
    const lines = logs.join('').split('\n').filter((l) => l.startsWith('{') && l.includes(traceId));
    const messages = lines.map((l) => JSON.parse(l).message as string);
    expect(messages).toEqual(expect.arrayContaining(['alerta gerado', 'alerta entregue ao canal antifraude', 'notificação enviada ao cliente']));
  });

  it('o traceId acompanha a entrega até a DLQ do canal', async () => {
    const { event, traceId } = await sendTraced(true);
    const alertId = await eventually(async () => (await pool.query('SELECT alert_id FROM alerts WHERE transaction_id = $1', [event.transactionId])).rows[0]?.alert_id);
    await eventually(async () => (await pool.query('SELECT 1 FROM deliveries WHERE delivery_id = $1 AND status = $2', [deliveryIdOf(alertId, 'PUSH'), 'DEAD_LETTERED'])).rows[0]);
    faults.customer = false;

    const dead = await drain(sqs, 'alert-deliveries-customer-push-dlq.fifo', (b) => (b.correlation as { alertId?: string } | undefined)?.alertId === alertId);
    expect(dead).toHaveLength(1);
    expect(dead[0].traceId).toBe(traceId);
    expect((dead[0].original as { payload: { traceId?: string } }).payload.traceId).toBe(traceId);
  });
});
