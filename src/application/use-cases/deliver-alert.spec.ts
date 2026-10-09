import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeliveryRepository } from '../ports/delivery-repository.port';
import { DlqPublisher } from '../ports/dlq-publisher.port';
import { NotificationProvider } from '../ports/notification-provider.port';
import { Logger, Metrics } from '../ports/observability.port';
import { DeliveryChannel, DeliveryStatus } from '../../domain/alert/alert-delivery';
import { deliveryIdOf } from '../../domain/alert/delivery-id';
import { FraudAlert } from '../../domain/alert/fraud-alert';
import { DlqMessage } from '../../domain/dlq/dlq-message';
import { AntifraudQueueProvider } from '../../infrastructure/channels/antifraud-queue.provider';
import { CustomerPushProvider } from '../../infrastructure/channels/customer-push.provider';
import { DeliverAlert } from './deliver-alert';

const alert = JSON.parse(readFileSync(join(__dirname, '../../../docs/contratos/examples/fraud-alert.valid.json'), 'utf8')) as FraudAlert;

const logger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const metrics: Metrics = { increment: jest.fn(), gauge: jest.fn(), observe: jest.fn() };

class FakeDeliveries implements DeliveryRepository {
  rows = new Map<string, { status: DeliveryStatus; attempts: number; lastError?: string }>();
  async register(d: { deliveryId: string }) {
    if (!this.rows.has(d.deliveryId)) this.rows.set(d.deliveryId, { status: 'PENDING', attempts: 0 });
    return this.rows.get(d.deliveryId)!.status;
  }
  async recordAttempt(id: string, code: string) {
    const r = this.rows.get(id)!;
    r.attempts++;
    r.lastError = code;
  }
  async markDelivered(id: string) {
    this.rows.get(id)!.status = 'DELIVERED';
  }
  async markDeadLettered(id: string, code: string) {
    const r = this.rows.get(id)!;
    r.status = 'DEAD_LETTERED';
    r.lastError = code;
  }
  async isDelivered(id: string) {
    return this.rows.get(id)?.status === 'DELIVERED';
  }
}

function setup(opts: { failChannels?: DeliveryChannel[]; dlqError?: Error } = {}) {
  const deliveries = new FakeDeliveries();
  const published: { queue: string; message: DlqMessage }[] = [];
  const dlq: DlqPublisher = {
    publish: jest.fn(async (queue, message) => {
      if (opts.dlqError) throw opts.dlqError;
      published.push({ queue, message });
    }),
  };
  const sleeps: number[] = [];
  const antifraud = new AntifraudQueueProvider(logger, () => !!opts.failChannels?.includes('ANTIFRAUD_QUEUE'));
  const push = new CustomerPushProvider(logger, () => !!opts.failChannels?.includes('PUSH'));
  const useCase = new DeliverAlert({
    deliveries,
    dlq,
    dlqQueues: { ANTIFRAUD_QUEUE: 'antifraud-dlq.fifo', PUSH: 'push-dlq.fifo' },
    logger,
    metrics,
    retryOptions: { attempts: 3, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    newId: () => '00000000-0000-4000-8000-000000000009',
  });
  return { deliveries, published, sleeps, antifraud, push, useCase };
}

describe('DeliverAlert', () => {
  it('entrega ao canal com deliveryId estável e marca DELIVERED', async () => {
    const { useCase, deliveries, push } = setup();
    await expect(useCase.execute(alert, push)).resolves.toBe('DELIVERED');
    const id = deliveryIdOf(alert.alertId, 'PUSH');
    expect(deliveries.rows.get(id)?.status).toBe('DELIVERED');
    expect(push.sent).toHaveLength(1);
  });

  it('entrega já DELIVERED não é reenviada (FR-017a/FR-024)', async () => {
    const { useCase, push } = setup();
    await useCase.execute(alert, push);
    await expect(useCase.execute(alert, push)).resolves.toBe('ALREADY_DELIVERED');
    expect(push.sent).toHaveLength(1);
  });

  it('falha de um canal não afeta o outro (FR-021)', async () => {
    const { useCase, antifraud, push, published, deliveries } = setup({ failChannels: ['PUSH'] });
    await expect(useCase.execute(alert, antifraud)).resolves.toBe('DELIVERED');
    await expect(useCase.execute(alert, push)).resolves.toBe('DEAD_LETTERED');
    expect(antifraud.delivered).toHaveLength(1);
    expect(deliveries.rows.get(deliveryIdOf(alert.alertId, 'ANTIFRAUD_QUEUE'))?.status).toBe('DELIVERED');
    expect(published).toHaveLength(1);
  });

  it('retenta com espera crescente e, ao esgotar, publica DlqMessage CHANNEL_DELIVERY e marca DEAD_LETTERED (FR-022/023)', async () => {
    const { useCase, push, published, sleeps, deliveries } = setup({ failChannels: ['PUSH'] });
    await expect(useCase.execute(alert, push)).resolves.toBe('DEAD_LETTERED');

    expect(sleeps).toEqual([50, 100]); // random=0.5 sobre 100 e 200
    const id = deliveryIdOf(alert.alertId, 'PUSH');
    expect(deliveries.rows.get(id)).toMatchObject({ status: 'DEAD_LETTERED', attempts: 3, lastError: 'ProviderUnavailable' });
    expect(published).toHaveLength(1);
    expect(published[0].queue).toBe('push-dlq.fifo');
    expect(published[0].message).toMatchObject({
      stage: 'CHANNEL_DELIVERY',
      reasonCode: 'MAX_RETRIES_EXCEEDED',
      attempts: 3,
      correlation: { alertId: alert.alertId, deliveryId: id, channel: 'PUSH' },
    });
    expect(JSON.stringify(published[0].message.reasonDetail)).not.toMatch(/R\$|cus_/);
  });

  it('entrega DEAD_LETTERED não é reprocessada', async () => {
    const { useCase, push, published } = setup({ failChannels: ['PUSH'] });
    await useCase.execute(alert, push);
    await expect(useCase.execute(alert, push)).resolves.toBe('DEAD_LETTERED');
    expect(published).toHaveLength(1);
  });

  it('falha ao publicar na DLQ propaga (a mensagem não deve ser excluída) e não marca DEAD_LETTERED', async () => {
    const { useCase, push, deliveries } = setup({ failChannels: ['PUSH'], dlqError: new Error('sqs fora') });
    await expect(useCase.execute(alert, push)).rejects.toThrow('sqs fora');
    expect(deliveries.rows.get(deliveryIdOf(alert.alertId, 'PUSH'))?.status).toBe('PENDING');
  });

  it('provedor que expira por timeout conta como falha', async () => {
    const { deliveries, published } = setup();
    const slow: NotificationProvider = {
      channel: 'PUSH',
      audience: 'CUSTOMER',
      buildDelivery: (a, id, now) => new CustomerPushProvider(logger).buildDelivery(a, id, now),
      send: () => new Promise(() => undefined),
    };
    const useCase = new DeliverAlert({
      deliveries,
      dlq: { publish: async (queue, message) => void published.push({ queue, message }) },
      dlqQueues: { PUSH: 'push-dlq.fifo' },
      logger,
      metrics,
      retryOptions: { attempts: 2, baseDelayMs: 1, timeoutMs: 20, sleep: async () => undefined },
    });
    await expect(useCase.execute(alert, slow)).resolves.toBe('DEAD_LETTERED');
    expect(published[0].message.reasonDetail).toContain('TimeoutError');
  });
});
