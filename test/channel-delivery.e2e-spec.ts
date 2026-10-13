import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { NOTIFICATION_PROVIDERS, NotificationProvider } from '../src/deliveries/notification-provider';
import { deliveryIdOf } from '../src/deliveries/delivery-id';
import { CustomerPushProvider } from '../src/deliveries/channels/customer-push.provider';
import { CustomerSmsProvider } from '../src/deliveries/channels/customer-sms.provider';
import { AntifraudQueueProvider } from '../src/deliveries/channels/antifraud-queue.provider';
import { CHANNEL_FAULTS, ChannelFaults } from '../src/deliveries/deliveries.module';
import { DeliverAlertService } from '../src/deliveries/deliver-alert.service';
import { InMemoryMetrics } from '../src/observability/metrics';
import { drain, newSqs, purge, readExample } from './integration/support';

jest.setTimeout(90_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = performance.now() + timeoutMs; // monotônico: imune a salto do relógio de parede
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > deadline) throw new Error('condição não satisfeita a tempo');
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
  let sms: CustomerSmsProvider;
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

  const status = async (id: string, channel: 'ANTIFRAUD_QUEUE' | 'PUSH' | 'SMS') =>
    (await pool.query('SELECT status, attempts FROM deliveries WHERE delivery_id = $1', [deliveryIdOf(id, channel)])).rows[0];

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://fraud:fraud@localhost:55432/fraud';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.RULES_CONFIG_PATH = 'config/rules.json';
    process.env.CHANNEL_DELIVERY_BASE_DELAY_MS = '20';
    process.env.CHANNEL_DELIVERY_MAX_DELAY_MS = '50';
    process.env.CHANNEL_BREAKER_FAILURE_THRESHOLD = '4';
    process.env.CHANNEL_BREAKER_OPEN_MS = '1000';
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
    sms = push.fallback as CustomerSmsProvider;
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

  it('push fora: o SMS (fallback) entrega ao cliente, o push fica FALLBACK_DELIVERED e nada vai à DLQ', async () => {
    faults.customer = true;
    try {
      const event = await send({ amount: { minorUnits: 2_500_000, currency: 'BRL' } });
      const id = await eventually(() => alertId(event.transactionId));
      await eventually(async () => (await status(id, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED');
      await eventually(async () => (await status(id, 'PUSH'))?.status === 'FALLBACK_DELIVERED');
      expect((await status(id, 'SMS'))?.status).toBe('DELIVERED');
      expect(sms.sent).toHaveLength(1);
      expect(JSON.stringify(sms.sent[0])).not.toMatch(/high-amount|score|severity|HIGH/);
      expect(await drain(sqs, 'alert-deliveries-customer-push-dlq.fifo', (b) => (b.correlation as { alertId?: string } | undefined)?.alertId === id)).toHaveLength(0);
    } finally {
      faults.customer = false;
    }
    // um push saudável zera a contagem de falhas consecutivas do breaker
    const healthy = await send({ amount: { minorUnits: 2_600_000, currency: 'BRL' } });
    const healthyId = await eventually(() => alertId(healthy.transactionId));
    await eventually(async () => (await status(healthyId, 'PUSH'))?.status === 'DELIVERED');
  });

  it('push e SMS fora, breaker fechado: o cliente vai à DLQ do canal e os demais alertas seguem', async () => {
    faults.customer = true;
    faults.sms = true;
    let otherId: string | undefined;
    try {
      const failing = await send({ amount: { minorUnits: 2_700_000, currency: 'BRL' } });
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
      otherId = await eventually(() => alertId(other.transactionId));
      await eventually(async () => (await status(otherId!, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED');
    } finally {
      faults.customer = false;
      faults.sms = false;
    }
    // o alerta que chegou com o canal fora (adiado pelo breaker) conclui quando o canal volta
    await eventually(async () => (await status(otherId!, 'PUSH'))?.status === 'DELIVERED', 30_000);
  });

  it('kill switch do canal: a entrega é adiada (sem DLQ) e conclui quando o canal é religado', async () => {
    const deliver = app.get(DeliverAlertService);
    const metrics = app.get(InMemoryMetrics);
    const deferredBefore = metrics.counterTotal('deliveries_total', { status: 'deferred' });
    deliver.setChannelDisabled('PUSH', true);
    deliver.setChannelDisabled('SMS', true);
    let id: string;
    try {
      const event = await send({ amount: { minorUnits: 3_100_000, currency: 'BRL' } });
      id = await eventually(() => alertId(event.transactionId));
      await eventually(async () => (await status(id, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED');
      await eventually(async () => metrics.counterTotal('deliveries_total', { status: 'deferred' }) > deferredBefore);
      expect((await status(id, 'PUSH'))?.status).toBe('PENDING');
      expect(await drain(sqs, 'alert-deliveries-customer-push-dlq.fifo', (b) => (b.correlation as { alertId?: string } | undefined)?.alertId === id)).toHaveLength(0);
    } finally {
      deliver.setChannelDisabled('PUSH', false);
      deliver.setChannelDisabled('SMS', false);
    }
    await eventually(async () => (await status(id!, 'PUSH'))?.status === 'DELIVERED', 30_000);
    expect(await status(id!, 'SMS')).toBeUndefined(); // o push voltou: o fallback não foi usado
  });
});
