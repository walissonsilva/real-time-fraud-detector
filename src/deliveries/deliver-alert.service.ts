import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { randomUUID } from 'node:crypto';
import { NotificationProvider } from './notification-provider';
import { retry, RetryOptions, withTimeout } from '../shared/retry';
import { BreakerState, CircuitBreaker, CircuitOpenError } from '../shared/circuit-breaker';
import { DELIVERY_TTL_MS } from './channels/antifraud-queue.provider';
import { DeliveryChannel } from './alert-delivery';
import { deliveryIdOf } from './delivery-id';
import { FraudAlert } from '../alerts/fraud-alert';
import { buildDlqMessage } from '../dlq/dlq-message';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { DeliveryRepository } from './delivery.repository';
import { SqsDlqPublisher } from '../dlq/sqs-dlq.publisher';

/**
 * DEFERRED: provedor com breaker aberto (ou canal desligado) e sem fallback que entregue; a mensagem continua na
 * fila e é reentregue depois (`retryAfterMs`), sem passar pela DLQ enquanto o alerta não vence.
 */
export type DeliverOutcome = 'DELIVERED' | 'ALREADY_DELIVERED' | 'DEAD_LETTERED' | 'FALLBACK_DELIVERED' | 'DEFERRED';

const BREAKER_GAUGE: Record<BreakerState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

const errorCodeOf = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'UnknownError';
};

/**
 * Entrega um alerta a UM canal, de forma idempotente (deliveryId estável) e isolada dos demais (FR-021).
 * Com timeout + retentativa com espera crescente (FR-022) por trás de um circuit breaker por provedor.
 * Falhou o primário: tenta o canal alternativo (push → SMS) com `deliveryId` próprio. Sem entrega:
 *  - breaker aberto (ou canal desligado) e alerta ainda válido → DEFERRED (fica na fila, não vai à DLQ);
 *  - alerta vencido (`DELIVERY_EXPIRED`) ou retentativas esgotadas com breaker fechado → DLQ do canal (FR-023).
 * Só lança em falha de infraestrutura (banco/DLQ): o chamador mantém a mensagem na fila para reentrega.
 */
@Injectable()
export class DeliverAlertService {
  /** Relógio e gerador de id substituíveis em testes. */
  now: () => Date = () => new Date();
  newId: () => string = randomUUID;
  /** Monotônico: o cooldown do breaker não pode depender do relógio de parede. */
  breakerClock: () => number = () => performance.now();
  /** DLQ por canal (nome lógico da fila). */
  readonly dlqQueues: Partial<Record<DeliveryChannel, string>>;
  /** Política de retentativa; `sleep`/`random` podem ser trocados em testes. */
  retryOptions: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'timeoutMs' | 'sleep' | 'random'>;
  private readonly breakers = new Map<DeliveryChannel, CircuitBreaker>();

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
    const disabled: Partial<Record<DeliveryChannel, boolean>> = {
      ANTIFRAUD_QUEUE: config.channels.disabledAntifraud,
      PUSH: config.channels.disabledCustomer,
      SMS: config.channels.disabledSms,
    };
    for (const channel of ['ANTIFRAUD_QUEUE', 'PUSH', 'SMS'] as const) this.createBreaker(channel, config, !!disabled[channel]);
  }

  breakerState(channel: DeliveryChannel): BreakerState {
    return this.breakers.get(channel)?.state ?? 'CLOSED';
  }

  setChannelDisabled(channel: DeliveryChannel, disabled: boolean): void {
    const breaker = this.breakers.get(channel);
    if (!breaker) return;
    breaker.forcedOpen = disabled;
    this.metrics.gauge('circuit_breaker_state', BREAKER_GAUGE[breaker.state], { channel });
  }

  retryAfterMs(provider: NotificationProvider): number {
    const waits = [provider, provider.fallback]
      .filter((p): p is NotificationProvider => !!p)
      .map((p) => this.breakers.get(p.channel)?.retryAfterMs() ?? 0);
    return Math.min(...waits);
  }

  private createBreaker(channel: DeliveryChannel, config: AppConfig, disabled: boolean): void {
    const { metrics, logger } = this;
    const breaker = new CircuitBreaker({
      failureThreshold: config.channels.breakerFailureThreshold,
      openDurationMs: config.channels.breakerOpenMs,
      now: () => this.breakerClock(),
      onStateChange: (state, previous) => {
        metrics.gauge('circuit_breaker_state', BREAKER_GAUGE[state], { channel });
        metrics.increment('circuit_breaker_transitions_total', { channel, to: state });
        logger.warn('circuit breaker do canal mudou de estado', { channel, from: previous, to: state });
      },
    });
    breaker.forcedOpen = disabled;
    this.breakers.set(channel, breaker);
    metrics.gauge('circuit_breaker_state', BREAKER_GAUGE[breaker.state], { channel });
  }

  /** Camadas: retry → breaker → timeout → `send`. */
  private async sendWithRetry(alert: FraudAlert, provider: NotificationProvider, deliveryId: string, startedAt: Date, onAttempt: () => number) {
    const breaker = this.breakers.get(provider.channel)!;
    const delivery = provider.buildDelivery(alert, deliveryId, startedAt);
    await retry(
      () =>
        breaker.exec(async () => {
          const attempt = onAttempt();
          try {
            await withTimeout(() => provider.send({ delivery: { ...delivery, attempt }, alert }), this.retryOptions.timeoutMs);
          } catch (err) {
            await this.deliveries.recordAttempt(deliveryId, errorCodeOf(err)).catch(() => undefined);
            throw err;
          }
        }),
      { ...this.retryOptions, timeoutMs: undefined, shouldRetry: (err) => !(err instanceof CircuitOpenError) },
    );
  }

  private async tryFallback(alert: FraudAlert, primary: NotificationProvider, primaryId: string, primaryError: string): Promise<boolean> {
    const { deliveries, logger, metrics } = this;
    const fallback = primary.fallback!;
    const fallbackId = deliveryIdOf(alert.alertId, fallback.channel);
    // A linha do alternativo só nasce quando ele entrega: falhas dele não deixam entrega PENDING órfã.
    if (!(await deliveries.isDelivered(fallbackId))) {
      const startedAt = this.now();
      let attempts = 0;
      try {
        await this.sendWithRetry(alert, fallback, fallbackId, startedAt, () => ++attempts);
      } catch {
        return false;
      }
      await deliveries.register({ deliveryId: fallbackId, alertId: alert.alertId, channel: fallback.channel });
      await deliveries.markDelivered(fallbackId);
      metrics.increment('deliveries_total', { channel: fallback.channel, status: 'delivered' });
      metrics.observe('delivery_latency_ms', this.now().getTime() - startedAt.getTime(), { channel: fallback.channel });
    }
    await deliveries.markFallbackDelivered(primaryId, primaryError);
    metrics.increment('deliveries_total', { channel: primary.channel, status: 'fallback' });
    logger.warn('canal primário indisponível; alerta entregue pelo canal alternativo', {
      alertId: alert.alertId,
      deliveryId: primaryId,
      fallbackChannel: fallback.channel,
      errorCode: primaryError,
      traceId: alert.traceId,
    });
    return true;
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
    if (status === 'FALLBACK_DELIVERED') return 'FALLBACK_DELIVERED';

    const startedAt = this.now();
    let attempts = 0;
    try {
      await this.sendWithRetry(alert, provider, deliveryId, startedAt, () => ++attempts);
    } catch (err) {
      const errorCode = errorCodeOf(err);
      const fallback = provider.fallback;
      if (fallback && (await this.tryFallback(alert, provider, deliveryId, errorCode))) return 'FALLBACK_DELIVERED';

      const blocked = [provider, fallback].some((p) => p && this.breakerState(p.channel) !== 'CLOSED');
      const detectedAt = Date.parse(alert.detectedAt);
      const expired = Number.isFinite(detectedAt) && this.now().getTime() >= detectedAt + DELIVERY_TTL_MS;
      if (blocked && !expired) {
        metrics.increment('deliveries_total', { channel, status: 'deferred' });
        logger.warn('canal indisponível (breaker aberto); entrega adiada', {
          alertId: alert.alertId,
          deliveryId,
          channel,
          retryAfterMs: this.retryAfterMs(provider),
          traceId: alert.traceId,
        });
        return 'DEFERRED';
      }

      const queue = this.dlqQueues[channel];
      if (!queue) throw new Error(`DLQ não configurada para o canal ${channel}`);
      await dlq.publish(
        queue,
        buildDlqMessage(
          {
            stage: 'CHANNEL_DELIVERY',
            reasonCode: expired ? 'DELIVERY_EXPIRED' : 'MAX_RETRIES_EXCEEDED',
            reasonDetail: expired
              ? `alerta vencido sem entrega (${attempts} tentativas); erro=${errorCode}`
              : `tentativas esgotadas (${attempts}); erro=${errorCode}`,
            attempts,
            firstFailedAt: startedAt,
            source: `channel:${channel}`,
            partitionKey: alert.accountId,
            rawBody: JSON.stringify(provider.buildDelivery(alert, deliveryId, startedAt)),
            correlation: { alertId: alert.alertId, deliveryId, channel },
            ...(alert.traceId ? { traceId: alert.traceId } : {}),
          },
          this.newId(),
        ),
      );
      await deliveries.markDeadLettered(deliveryId, errorCode);
      metrics.increment('deliveries_total', { channel, status: 'dead_lettered' });
      metrics.increment('dlq_total', { stage: 'CHANNEL_DELIVERY' });
      logger.error(expired ? 'alerta vencido; enviado à DLQ do canal' : 'entrega esgotou as tentativas; enviada à DLQ do canal', {
        alertId: alert.alertId,
        deliveryId,
        channel,
        attempts,
        errorCode,
        traceId: alert.traceId,
      });
      return 'DEAD_LETTERED';
    }

    await deliveries.markDelivered(deliveryId);
    metrics.increment('deliveries_total', { channel, status: 'delivered' });
    metrics.observe('delivery_latency_ms', this.now().getTime() - startedAt.getTime(), { channel });
    return 'DELIVERED';
  }
}
