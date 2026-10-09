import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { NOTIFICATION_PROVIDERS, NotificationProvider } from '../src/deliveries/notification-provider';
import { deliveryIdOf } from '../src/deliveries/delivery-id';
import { CustomerPushProvider } from '../src/deliveries/channels/customer-push.provider';
import { AntifraudQueueProvider } from '../src/deliveries/channels/antifraud-queue.provider';
import { CHANNEL_FAULTS, ChannelFaults } from '../src/deliveries/deliveries.module';
import { drain, newSqs, purge, readExample } from './integration/support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condição não satisfeita a tempo');
    await sleep(250);
  }
}

describe('entrega aos canais ponta a ponta (requer `npm run infra:up` e `npm run migrate`)', () => {
  const runId = randomUUID().slice(0, 8);
  const sqs = newSqs();
  let pool: Pool;
  let app: INestApplication;
  let queueUrl: string;
  let faults: ChannelFaults;
  let antifraud: AntifraudQueueProvider;
  let push: CustomerPushProvider;
  const transactionIds: string[] = [];

  const send = async (patch: Record<string, unknown>) => {
    const event = {
      ...readExample('transaction-event.authorized.valid.json'),
      eventId: randomUUID(),
      transactionId: `tx-e2e-ch-${runId}-${randomUUID().slice(0, 8)}`,
      accountId: `acc-e2e-ch-${runId}`,
      ...patch,
    };
    transactionIds.push(event.transactionId);
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(event) }));
    return event;
  };

  const alertId = async (transactionId: string): Promise<string | undefined> =>
    (await pool.query('SELECT alert_id FROM alerts WHERE transaction_id = $1', [transactionId])).rows[0]?.alert_id;

  const status = async (id: string, channel: 'ANTIFRAUD_QUEUE' | 'PUSH') =>
    (await pool.query('SELECT status, attempts FROM deliveries WHERE delivery_id = $1', [deliveryIdOf(id, channel)])).rows[0];

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://fraud:fraud@localhost:55432/fraud';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.RULES_CONFIG_PATH = 'config/rules.json';
    process.env.CHANNEL_DELIVERY_BASE_DELAY_MS = '20';
    process.env.CHANNEL_DELIVERY_MAX_DELAY_MS = '50';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'transactions' }))).QueueUrl!;
    await purge(sqs, [
      'transactions',
      'alert-deliveries-antifraud-queue.fifo',
      'alert-deliveries-customer-push.fifo',
      'alert-deliveries-antifraud-queue-dlq.fifo',
      'alert-deliveries-customer-push-dlq.fifo',
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    faults = app.get<ChannelFaults>(CHANNEL_FAULTS);
    const providers = app.get<NotificationProvider[]>(NOTIFICATION_PROVIDERS);
    antifraud = providers.find((p) => p.channel === 'ANTIFRAUD_QUEUE') as AntifraudQueueProvider;
    push = providers.find((p) => p.channel === 'PUSH') as CustomerPushProvider;
  });

  afterAll(async () => {
    await app.close();
    await pool.query('DELETE FROM deliveries WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
    await pool.query('DELETE FROM outbox WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
    await pool.query('DELETE FROM alerts WHERE transaction_id = ANY($1)', [transactionIds]);
    await pool.end();
    sqs.destroy();
  });

  it('alerta gerado é entregue aos dois canais, uma vez cada', async () => {
    const event = await send({ amount: { minorUnits: 2_000_000, currency: 'BRL' } });
    const id = await eventually(() => alertId(event.transactionId));
    await eventually(async () => (await status(id, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED' && (await status(id, 'PUSH'))?.status === 'DELIVERED');

    expect(antifraud.delivered.filter((n) => n.alert.alertId === id)).toHaveLength(1);
    // a mensagem ao cliente não carrega dados internos
    const customerMsg = push.sent.at(-1)!;
    expect(JSON.stringify(customerMsg)).not.toMatch(/high-amount|score|severity|HIGH/);
  });

  it('falha no canal do cliente: o interno é entregue, o cliente vai à DLQ do canal e os demais alertas seguem', async () => {
    faults.customer = true;
    try {
      const failing = await send({ amount: { minorUnits: 2_500_000, currency: 'BRL' } });
      const id = await eventually(() => alertId(failing.transactionId));
      await eventually(async () => (await status(id, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED');
      const row = await eventually(async () => {
        const r = await status(id, 'PUSH');
        return r?.status === 'DEAD_LETTERED' ? r : undefined;
      });
      expect(row.attempts).toBe(3);

      const dead = await drain(sqs, 'alert-deliveries-customer-push-dlq.fifo', (b) => (b.correlation as { alertId?: string } | undefined)?.alertId === id);
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({ stage: 'CHANNEL_DELIVERY', reasonCode: 'MAX_RETRIES_EXCEEDED' });

      // a detecção segue funcionando enquanto o canal está fora
      const other = await send({ amount: { minorUnits: 3_000_000, currency: 'BRL' } });
      const otherId = await eventually(() => alertId(other.transactionId));
      await eventually(async () => (await status(otherId, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED');
    } finally {
      faults.customer = false;
    }
  });
});
