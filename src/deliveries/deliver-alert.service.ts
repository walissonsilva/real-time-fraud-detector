import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { randomUUID } from 'node:crypto';
import { NotificationProvider } from './notification-provider';
import { retry, RetryOptions } from '../shared/retry';
import { DeliveryChannel } from './alert-delivery';
import { deliveryIdOf } from './delivery-id';
import { FraudAlert } from '../alerts/fraud-alert';
import { buildDlqMessage } from '../dlq/dlq-message';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { DeliveryRepository } from './delivery.repository';
import { SqsDlqPublisher } from '../dlq/sqs-dlq.publisher';

export type DeliverOutcome = 'DELIVERED' | 'ALREADY_DELIVERED' | 'DEAD_LETTERED';

const errorCodeOf = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'UnknownError';
};

/**
 * Entrega um alerta a UM canal, de forma idempotente (deliveryId estável) e isolada dos demais (FR-021).
 * Com timeout + retentativa com espera crescente (FR-022); esgotadas as tentativas, vai à DLQ do canal (FR-023).
 * Só lança em falha de infraestrutura (banco/DLQ): o chamador mantém a mensagem na fila para reentrega.
 */
@Injectable()
export class DeliverAlertService {
  /** Relógio e gerador de id substituíveis em testes. */
  now: () => Date = () => new Date();
  newId: () => string = randomUUID;
  /** DLQ por canal (nome lógico da fila). */
  readonly dlqQueues: Partial<Record<DeliveryChannel, string>>;
  /** Política de retentativa; `sleep`/`random` podem ser trocados em testes. */
  retryOptions: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'timeoutMs' | 'sleep' | 'random'>;

  constructor(
    private readonly deliveries: DeliveryRepository,
    private readonly dlq: SqsDlqPublisher,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: JsonLogger,
    private readonly metrics: InMemoryMetrics,
  ) {
    this.dlqQueues = { ANTIFRAUD_QUEUE: config.queues.antifraudChannelDlq, PUSH: config.queues.customerChannelDlq };
    this.retryOptions = {
      attempts: config.channels.maxAttempts,
      baseDelayMs: config.channels.baseDelayMs,
      maxDelayMs: config.channels.maxDelayMs,
      timeoutMs: config.channels.sendTimeoutMs,
    };
  }

  async execute(alert: FraudAlert, provider: NotificationProvider): Promise<DeliverOutcome> {
    const { deliveries, dlq, logger, metrics } = this;
    const channel = provider.channel;
    const deliveryId = deliveryIdOf(alert.alertId, channel);

    const status = await deliveries.register({ deliveryId, alertId: alert.alertId, channel });
    if (status === 'DELIVERED') {
      logger.info('entrega já concluída; ignorada', { alertId: alert.alertId, deliveryId, channel, traceId: alert.traceId });
      return 'ALREADY_DELIVERED';
    }
    if (status === 'DEAD_LETTERED') return 'DEAD_LETTERED';

    const startedAt = this.now();
    const delivery = provider.buildDelivery(alert, deliveryId, startedAt);
    let attempts = 0;
    try {
      await retry(async () => {
        attempts++;
        try {
          await provider.send({ delivery: { ...delivery, attempt: attempts }, alert });
        } catch (err) {
          await deliveries.recordAttempt(deliveryId, errorCodeOf(err)).catch(() => undefined);
          throw err;
        }
      }, this.retryOptions);
    } catch (err) {
      const errorCode = errorCodeOf(err);
      const queue = this.dlqQueues[channel];
      if (!queue) throw new Error(`DLQ não configurada para o canal ${channel}`);
      await dlq.publish(
        queue,
        buildDlqMessage(
          {
            stage: 'CHANNEL_DELIVERY',
            reasonCode: 'MAX_RETRIES_EXCEEDED',
            reasonDetail: `tentativas esgotadas (${attempts}); erro=${errorCode}`,
            attempts,
            firstFailedAt: startedAt,
            source: `channel:${channel}`,
            partitionKey: alert.accountId,
            rawBody: JSON.stringify(delivery),
            correlation: { alertId: alert.alertId, deliveryId, channel },
            ...(alert.traceId ? { traceId: alert.traceId } : {}),
          },
          this.newId(),
        ),
      );
      await deliveries.markDeadLettered(deliveryId, errorCode);
      metrics.increment('deliveries_total', { channel, status: 'dead_lettered' });
      metrics.increment('dlq_total', { stage: 'CHANNEL_DELIVERY' });
      logger.error('entrega esgotou as tentativas; enviada à DLQ do canal', { alertId: alert.alertId, deliveryId, channel, attempts, errorCode, traceId: alert.traceId });
      return 'DEAD_LETTERED';
    }

    await deliveries.markDelivered(deliveryId);
    metrics.increment('deliveries_total', { channel, status: 'delivered' });
    metrics.observe('delivery_latency_ms', this.now().getTime() - startedAt.getTime(), { channel });
    return 'DELIVERED';
  }
}
