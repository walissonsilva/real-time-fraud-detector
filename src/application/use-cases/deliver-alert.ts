import { randomUUID } from 'node:crypto';
import { DeliveryRepository } from '../ports/delivery-repository.port';
import { DlqPublisher } from '../ports/dlq-publisher.port';
import { NotificationProvider } from '../ports/notification-provider.port';
import { Logger, Metrics } from '../ports/observability.port';
import { retry, RetryOptions } from '../shared/retry';
import { DeliveryChannel } from '../../domain/alert/alert-delivery';
import { deliveryIdOf } from '../../domain/alert/delivery-id';
import { FraudAlert } from '../../domain/alert/fraud-alert';
import { buildDlqMessage } from '../../domain/dlq/dlq-message';

export type DeliverOutcome = 'DELIVERED' | 'ALREADY_DELIVERED' | 'DEAD_LETTERED';

export interface DeliverAlertDeps {
  readonly deliveries: DeliveryRepository;
  readonly dlq: DlqPublisher;
  /** DLQ por canal (nome lógico da fila). */
  readonly dlqQueues: Partial<Record<DeliveryChannel, string>>;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly retryOptions: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'timeoutMs' | 'sleep' | 'random'>;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

const errorCodeOf = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'UnknownError';
};

/**
 * Entrega um alerta a UM canal, de forma idempotente (deliveryId estável) e isolada dos demais (FR-021).
 * Com timeout + retentativa com espera crescente (FR-022); esgotadas as tentativas, vai à DLQ do canal (FR-023).
 * Só lança em falha de infraestrutura (banco/DLQ): o chamador mantém a mensagem na fila para reentrega.
 */
export class DeliverAlert {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: DeliverAlertDeps) {
    this.now = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async execute(alert: FraudAlert, provider: NotificationProvider): Promise<DeliverOutcome> {
    const { deliveries, dlq, logger, metrics } = this.deps;
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
      }, this.deps.retryOptions);
    } catch (err) {
      const errorCode = errorCodeOf(err);
      const queue = this.deps.dlqQueues[channel];
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
