import { randomUUID } from 'node:crypto';
import { SendMessageCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { SNSClient } from '@aws-sdk/client-sns';
import { Pool } from 'pg';
import { DeliverAlertService } from '../../src/deliveries/deliver-alert.service';
import { OutboxEntryPublisherService } from '../../src/alerts/outbox-entry-publisher.service';
import { ProcessTransactionService } from '../../src/transactions/process-transaction.service';
import { deliveryIdOf } from '../../src/deliveries/delivery-id';
import { AntifraudQueueProvider } from '../../src/deliveries/channels/antifraud-queue.provider';
import { CustomerPushProvider } from '../../src/deliveries/channels/customer-push.provider';
import { loadConfig } from '../../src/config/config.module';
import { SnsEventBus } from '../../src/alerts/sns-event-bus';
import { SqsChannelConsumer } from '../../src/deliveries/sqs-channel.consumer';
import { SqsDlqPublisher } from '../../src/dlq/sqs-dlq.publisher';
import { DeclarativeRuleEngine } from '../../src/rules/declarative-rule-engine';
import { loadRulesConfig } from '../../src/rules/rules-config.loader';
import { StaticRuleRepository } from '../../src/rules/static-rule.repository';
import { AlertRepository } from '../../src/alerts/alert.repository';
import { DeliveryRepository } from '../../src/deliveries/delivery.repository';
import { CHANNEL_QUEUES, drain, ingested, newPool, newSqs, purge, suspiciousEvent } from './support';
import { JsonLogger } from '../../src/observability/logger';
import { InMemoryMetrics } from '../../src/observability/metrics';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as JsonLogger;
const metrics = { increment: () => undefined, gauge: () => undefined, observe: () => undefined } as unknown as InMemoryMetrics;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condição não satisfeita a tempo');
    await sleep(200);
  }
}

describe('entrega por canal: SNS → SQS → provedores (requer infra:up e migrate)', () => {
  const runId = randomUUID().slice(0, 8);
  const config = loadConfig();
  const pool: Pool = newPool();
  const sqs = newSqs();
  const sns = new SNSClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });
  const alertsRepo = new AlertRepository(pool);
  const deliveries = new DeliveryRepository(pool);
  const dlq = new SqsDlqPublisher(sqs);
  const engine = new DeclarativeRuleEngine();
  const rules = new StaticRuleRepository(loadRulesConfig('config/rules.json', engine));
  const publisher = new OutboxEntryPublisherService(alertsRepo, new SnsEventBus(sns, { snsAlertsTopic: 'alerts.fifo', snsPublishTimeoutMs: 5000 }), logger, metrics);
  const processTx = new ProcessTransactionService(rules, engine, alertsRepo, publisher, logger, metrics);

  let customerFails = false;
  const antifraud = new AntifraudQueueProvider(logger);
  const push = new CustomerPushProvider(logger, () => customerFails);
  const deliver = new DeliverAlertService(deliveries, dlq, config, logger, metrics);
  deliver.retryOptions = { attempts: 3, baseDelayMs: 20, maxDelayMs: 50, timeoutMs: 1000 };
  const consumers = [
    new SqsChannelConsumer(sqs, antifraud, deliver, dlq, logger, metrics, { queue: config.queues.antifraudChannel, dlqQueue: config.queues.antifraudChannelDlq, pollers: 1 }),
    new SqsChannelConsumer(sqs, push, deliver, dlq, logger, metrics, { queue: config.queues.customerChannel, dlqQueue: config.queues.customerChannelDlq, pollers: 1 }),
  ];
  const transactionIds: string[] = [];

  const statusOf = async (alertId: string, channel: 'ANTIFRAUD_QUEUE' | 'PUSH') =>
    (await pool.query('SELECT status, attempts, last_error FROM deliveries WHERE delivery_id = $1', [deliveryIdOf(alertId, channel)])).rows[0];

  const alertFor = async (transactionId: string) =>
    (await pool.query('SELECT alert_id, published_at, detected_at FROM alerts WHERE transaction_id = $1', [transactionId])).rows[0];

  beforeAll(async () => {
    await purge(sqs, [...CHANNEL_QUEUES, config.queues.antifraudChannelDlq, config.queues.customerChannelDlq]);
    await Promise.all(consumers.map((c) => c.start()));
  });

  afterAll(async () => {
    await Promise.all(consumers.map((c) => c.stop()));
    if (transactionIds.length) {
      await pool.query('DELETE FROM deliveries WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
      await pool.query('DELETE FROM outbox WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
      await pool.query('DELETE FROM alerts WHERE transaction_id = ANY($1)', [transactionIds]);
    }
    await pool.end();
    sqs.destroy();
    sns.destroy();
  });

  it('cenário 1: um alerta gera uma entrega por canal, cada uma com seu deliveryId', async () => {
    const event = suspiciousEvent(runId);
    transactionIds.push(event.transactionId);
    await processTx.execute(ingested(event));
    const { alert_id: alertId } = await alertFor(event.transactionId);

    await eventually(async () => (await statusOf(alertId, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED' && (await statusOf(alertId, 'PUSH'))?.status === 'DELIVERED');
    expect(antifraud.delivered.filter((n) => n.alert.alertId === alertId)).toHaveLength(1);
    expect(push.sent).toHaveLength(1);
  });

  it('reentrega da mesma mensagem de canal não repete a entrega (FR-017a/FR-024)', async () => {
    const event = suspiciousEvent(runId);
    transactionIds.push(event.transactionId);
    await processTx.execute(ingested(event));
    const { alert_id: alertId } = await alertFor(event.transactionId);
    await eventually(async () => (await statusOf(alertId, 'PUSH'))?.status === 'DELIVERED');
    const before = push.sent.length;

    // reinjeta o mesmo alerta na fila do canal (nova dedupe de SQS, como numa reentrega do broker)
    const { rows } = await pool.query('SELECT payload FROM outbox WHERE alert_id = $1', [alertId]);
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.queues.customerChannel }));
    await sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(rows[0].payload),
        MessageGroupId: event.accountId,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    await sleep(2000);
    expect(push.sent.length).toBe(before);
    expect((await statusOf(alertId, 'PUSH')).status).toBe('DELIVERED');
  });

  it('cenário 5: provedor do cliente falhando → interno entregue, cliente retentado e, ao esgotar, DLQ do canal; detecção não é afetada (SC-005)', async () => {
    customerFails = true;
    const event = suspiciousEvent(runId);
    transactionIds.push(event.transactionId);
    await processTx.execute(ingested(event));
    const { alert_id: alertId, published_at: publishedAt } = await alertFor(event.transactionId);
    expect(publishedAt).not.toBeNull(); // a publicação do alerta não espera os canais

    await eventually(async () => (await statusOf(alertId, 'ANTIFRAUD_QUEUE'))?.status === 'DELIVERED');
    const pushRow = await eventually(async () => {
      const r = await statusOf(alertId, 'PUSH');
      return r?.status === 'DEAD_LETTERED' ? r : undefined;
    });
    customerFails = false;

    expect(pushRow).toMatchObject({ attempts: 3, last_error: 'ProviderUnavailable' });
    const dead = await drain(sqs, config.queues.customerChannelDlq, (b) => (b.correlation as { alertId?: string } | undefined)?.alertId === alertId);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      stage: 'CHANNEL_DELIVERY',
      reasonCode: 'MAX_RETRIES_EXCEEDED',
      attempts: 3,
      correlation: { channel: 'PUSH', deliveryId: deliveryIdOf(alertId, 'PUSH') },
    });
    // o canal interno não tem nada na DLQ
    expect(await drain(sqs, config.queues.antifraudChannelDlq, (b) => (b.correlation as { alertId?: string } | undefined)?.alertId === alertId, { rounds: 2 })).toHaveLength(0);
  });
});
