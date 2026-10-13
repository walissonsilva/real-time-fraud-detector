import { AppConfig } from '../../config/config.module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationProvider } from '../notification-provider';
import { DeliveryChannel, DeliveryStatus } from '../types/alert-delivery';
import { deliveryIdOf } from '../delivery-id';
import { FraudAlert } from '../../alerts/types/fraud-alert';
import { DlqMessage } from '../../dlq/dlq-message';
import { AntifraudQueueProvider } from '../channels/antifraud-queue.provider';
import { CustomerPushProvider } from '../channels/customer-push.provider';
import { CustomerSmsProvider } from '../channels/customer-sms.provider';
import { DeliverAlertService } from '../deliver-alert.service';
import { JsonLogger } from '../../observability/logger';
import { InMemoryMetrics } from '../../observability/metrics';
import { DeliveryRepository } from '../delivery.repository';
import { SqsDlqPublisher } from '../../dlq/sqs-dlq.publisher';

const alert = JSON.parse(readFileSync(join(__dirname, '../../../docs/contratos/examples/fraud-alert.valid.json'), 'utf8')) as FraudAlert;

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as JsonLogger;
const metrics = { increment: jest.fn(), gauge: jest.fn(), observe: jest.fn() } as unknown as InMemoryMetrics;

const TEST_CONFIG = {
  queues: { antifraudChannelDlq: 'antifraud-dlq.fifo', customerChannelDlq: 'push-dlq.fifo' },
  channels: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 2000,
    sendTimeoutMs: 2000,
    breakerFailureThreshold: 5,
    breakerOpenMs: 30000,
    disabledAntifraud: false,
    disabledCustomer: false,
    disabledSms: false,
  },
} as AppConfig;

class FakeDeliveries {
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
  async markFallbackDelivered(id: string, code: string) {
    const r = this.rows.get(id)!;
    if (r.status === 'PENDING') {
      r.status = 'FALLBACK_DELIVERED';
      r.lastError = code;
    }
  }
  async isDelivered(id: string) {
    return this.rows.get(id)?.status === 'DELIVERED';
  }
}

function setup(opts: { failChannels?: DeliveryChannel[]; dlqError?: Error; config?: Partial<AppConfig['channels']> } = {}) {
  const deliveries = new FakeDeliveries();
  const published: { queue: string; message: DlqMessage }[] = [];
  const dlq = {
    publish: jest.fn(async (queue: string, message: DlqMessage) => {
      if (opts.dlqError) throw opts.dlqError;
      published.push({ queue, message });
    }),
  };
  const sleeps: number[] = [];
  const antifraud = new AntifraudQueueProvider(logger, () => !!opts.failChannels?.includes('ANTIFRAUD_QUEUE'));
  const sms = new CustomerSmsProvider(logger, () => !!opts.failChannels?.includes('SMS'));
  const push = new CustomerPushProvider(logger, () => !!opts.failChannels?.includes('PUSH'));
  const pushWithFallback = new CustomerPushProvider(logger, () => !!opts.failChannels?.includes('PUSH'), sms);
  const useCase = new DeliverAlertService(
    deliveries as unknown as DeliveryRepository,
    dlq as unknown as SqsDlqPublisher,
    { ...TEST_CONFIG, channels: { ...TEST_CONFIG.channels, ...opts.config } },
    logger,
    metrics,
  );
  useCase.dlqQueues.ANTIFRAUD_QUEUE = 'antifraud-dlq.fifo';
  useCase.dlqQueues.PUSH = 'push-dlq.fifo';
  useCase.retryOptions = { attempts: 3, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 };
  useCase.newId = () => '00000000-0000-4000-8000-000000000009';
  let nowMs = Date.parse(alert.detectedAt) + 1000;
  useCase.now = () => new Date(nowMs);
  useCase.breakerClock = () => nowMs;
  const advance = (ms: number) => (nowMs += ms);
  return { deliveries, published, sleeps, antifraud, push, pushWithFallback, sms, useCase, advance };
}

describe('DeliverAlertService', () => {
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
    const useCase = new DeliverAlertService(
      deliveries as unknown as DeliveryRepository,
      { publish: async (queue: string, message: DlqMessage) => void published.push({ queue, message }) } as unknown as SqsDlqPublisher,
      TEST_CONFIG,
      logger,
      metrics,
    );
    useCase.dlqQueues.PUSH = 'push-dlq.fifo';
    useCase.retryOptions = { attempts: 2, baseDelayMs: 1, timeoutMs: 20, sleep: async () => undefined };
    await expect(useCase.execute(alert, slow)).resolves.toBe('DEAD_LETTERED');
    expect(published[0].message.reasonDetail).toContain('TimeoutError');
  });

  describe('circuit breaker, fallback e adiamento', () => {
    const pushId = deliveryIdOf(alert.alertId, 'PUSH');
    const smsId = deliveryIdOf(alert.alertId, 'SMS');

    it('push falha → SMS entrega com deliveryId próprio e o push fica FALLBACK_DELIVERED, sem DLQ', async () => {
      const { useCase, pushWithFallback, sms, deliveries, published } = setup({ failChannels: ['PUSH'] });
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('FALLBACK_DELIVERED');
      expect(sms.sent).toHaveLength(1);
      expect(deliveries.rows.get(smsId)?.status).toBe('DELIVERED');
      expect(deliveries.rows.get(pushId)?.status).toBe('FALLBACK_DELIVERED');
      expect(published).toHaveLength(0);
      expect(metrics.increment).toHaveBeenCalledWith('deliveries_total', { channel: 'PUSH', status: 'fallback' });
    });

    it('reentrega depois do fallback não reenvia nem SMS nem push', async () => {
      const { useCase, pushWithFallback, sms } = setup({ failChannels: ['PUSH'] });
      await useCase.execute(alert, pushWithFallback);
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('FALLBACK_DELIVERED');
      expect(sms.sent).toHaveLength(1);
    });

    it('SMS já entregue e push ainda PENDING (queda entre os passos): não reenvia o SMS', async () => {
      const { useCase, pushWithFallback, sms, deliveries } = setup({ failChannels: ['PUSH'] });
      deliveries.rows.set(smsId, { status: 'DELIVERED', attempts: 1 });
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('FALLBACK_DELIVERED');
      expect(sms.sent).toHaveLength(0);
      expect(deliveries.rows.get(pushId)?.status).toBe('FALLBACK_DELIVERED');
    });

    it('com o breaker do push aberto, falha rápida (sem backoff) e entrega por SMS', async () => {
      const { useCase, pushWithFallback, sms, sleeps } = setup({ failChannels: ['PUSH'], config: { breakerFailureThreshold: 3 } });
      await useCase.execute(alert, pushWithFallback); // 3 falhas abrem o breaker
      expect(useCase.breakerState('PUSH')).toBe('OPEN');
      sleeps.length = 0;
      await expect(useCase.execute({ ...alert, alertId: 'alert-2' }, pushWithFallback)).resolves.toBe('FALLBACK_DELIVERED');
      expect(sleeps).toEqual([]);
      expect(sms.sent).toHaveLength(2);
    });

    it('push e SMS fora: breaker aberto adia (DEFERRED), sem DLQ e sem marcar a entrega', async () => {
      const { useCase, pushWithFallback, published, deliveries } = setup({ failChannels: ['PUSH', 'SMS'], config: { breakerFailureThreshold: 3 } });
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('DEFERRED');
      expect(published).toHaveLength(0);
      expect(deliveries.rows.get(pushId)?.status).toBe('PENDING');
      expect(useCase.retryAfterMs(pushWithFallback)).toBeGreaterThan(0);
    });

    it('adiada e alerta vencido (> TTL) → DLQ com DELIVERY_EXPIRED', async () => {
      const { useCase, pushWithFallback, published, deliveries, advance } = setup({ failChannels: ['PUSH', 'SMS'], config: { breakerFailureThreshold: 3 } });
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('DEFERRED');
      advance(11 * 60 * 1000);
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('DEAD_LETTERED');
      expect(published[0].message.reasonCode).toBe('DELIVERY_EXPIRED');
      expect(deliveries.rows.get(pushId)?.status).toBe('DEAD_LETTERED');
    });

    it('recuperação: após o cooldown a sonda passa e a entrega adiada é concluída pelo push', async () => {
      const failChannels: DeliveryChannel[] = ['PUSH', 'SMS'];
      const { useCase, pushWithFallback, sms, deliveries, advance } = setup({ failChannels, config: { breakerFailureThreshold: 3 } });
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('DEFERRED');
      failChannels.length = 0;
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('DEFERRED'); // ainda dentro do cooldown
      advance(31_000);
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('DELIVERED');
      expect(pushWithFallback.sent).toHaveLength(1);
      expect(sms.sent).toHaveLength(0);
      expect(deliveries.rows.get(pushId)?.status).toBe('DELIVERED');
      expect(useCase.breakerState('PUSH')).toBe('CLOSED');
    });

    it('kill switch do canal: breaker forçado aberto, push cai direto no SMS e antifraude é adiado', async () => {
      const { useCase, pushWithFallback, antifraud, sms, sleeps } = setup({ config: { disabledCustomer: true, disabledAntifraud: true } });
      await expect(useCase.execute(alert, pushWithFallback)).resolves.toBe('FALLBACK_DELIVERED');
      await expect(useCase.execute(alert, antifraud)).resolves.toBe('DEFERRED');
      expect(sms.sent).toHaveLength(1);
      expect(antifraud.delivered).toHaveLength(0);
      expect(sleeps).toEqual([]);
      useCase.setChannelDisabled('ANTIFRAUD_QUEUE', false);
      await expect(useCase.execute(alert, antifraud)).resolves.toBe('DELIVERED');
    });

    it('breaker é por canal: antifraude segue entregando com o push aberto', async () => {
      const { useCase, pushWithFallback, antifraud } = setup({ failChannels: ['PUSH', 'SMS'], config: { breakerFailureThreshold: 3 } });
      await useCase.execute(alert, pushWithFallback);
      await expect(useCase.execute(alert, antifraud)).resolves.toBe('DELIVERED');
    });
  });
});
