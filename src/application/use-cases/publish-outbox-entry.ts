import { AlertRepository, OutboxEntry } from '../ports/alert-repository.port';
import { EventBus } from '../ports/event-bus.port';
import { Logger, Metrics } from '../ports/observability.port';
import { PublishableFraudAlert } from '../../domain/alert/fraud-alert';

export interface OutboxPublisherDeps {
  readonly alerts: AlertRepository;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock?: () => Date;
}

const errorCodeOf = (err: unknown): string => {
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'UnknownError';
};

/**
 * Publica uma linha do outbox no barramento e a marca como publicada.
 * Nunca lança: falhas ficam registradas no outbox para o relay tentar de novo (D-05).
 * Devolve `true` se o SNS aceitou a mensagem.
 */
export class OutboxEntryPublisher {
  private readonly now: () => Date;

  constructor(private readonly deps: OutboxPublisherDeps) {
    this.now = deps.clock ?? (() => new Date());
  }

  async publish(entry: OutboxEntry): Promise<boolean> {
    const { alerts, bus, logger, metrics } = this.deps;
    const { alert } = entry;
    const publishedAt = this.now();
    const stamped: PublishableFraudAlert = {
      ...alert,
      publishedAt: publishedAt.toISOString(),
      latencyMs: Math.max(0, publishedAt.getTime() - new Date(alert.ingestedAt).getTime()),
    };

    try {
      await bus.publishAlert(stamped, entry.traceparent);
    } catch (err) {
      metrics.increment('outbox_publish_total', { result: 'failure' });
      logger.warn('falha ao publicar alerta; o relay fará nova tentativa', {
        alertId: alert.alertId,
        traceId: alert.traceId,
        errorCode: errorCodeOf(err),
      });
      await alerts.recordPublishFailure(alert.alertId, errorCodeOf(err)).catch((e: unknown) =>
        logger.error('falha ao registrar erro de publicação no outbox', { alertId: alert.alertId, errorCode: errorCodeOf(e) }),
      );
      return false;
    }

    metrics.increment('outbox_publish_total', { result: 'success' });
    metrics.observe('alert_latency_ms', stamped.latencyMs);
    try {
      await alerts.markPublished(alert.alertId, publishedAt);
    } catch (err) {
      // Publicado, mas a marcação falhou: o relay republica e o SNS FIFO absorve a duplicata.
      logger.warn('alerta publicado, mas a marcação no outbox falhou', { alertId: alert.alertId, errorCode: errorCodeOf(err) });
    }
    return true;
  }
}
