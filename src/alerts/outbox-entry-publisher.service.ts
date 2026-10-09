import { Injectable } from '@nestjs/common';
import { PublishableFraudAlert } from './fraud-alert';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { AlertRepository, OutboxEntry } from './alert.repository';
import { SnsEventBus } from './sns-event-bus';

const errorCodeOf = (err: unknown): string => {
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'UnknownError';
};

/**
 * Publica uma linha do outbox no barramento e a marca como publicada.
 * O `publishedAt`/`latencyMs` do corpo marcam o envio; a métrica `alert_latency_ms` e o `published_at` do banco usam o aceite.
 * Nunca lança: falhas ficam registradas no outbox para o relay tentar de novo (D-05).
 * Devolve `true` se o SNS aceitou a mensagem.
 */
@Injectable()
export class OutboxEntryPublisherService {
  /** Relógio substituível em testes. */
  now: () => Date = () => new Date();

  constructor(
    private readonly alerts: AlertRepository,
    private readonly bus: SnsEventBus,
    private readonly logger: JsonLogger,
    private readonly metrics: InMemoryMetrics,
  ) {}

  async publish(entry: OutboxEntry): Promise<boolean> {
    const { alerts, bus, logger, metrics } = this;
    const { alert } = entry;
    // Carimbo do corpo: momento do envio ao barramento (o contrato exige o campo na própria mensagem,
    // então ele não pode conter o instante do aceite, que só existe depois do publish).
    const sentAt = this.now();
    const stamped: PublishableFraudAlert = {
      ...alert,
      publishedAt: sentAt.toISOString(),
      latencyMs: Math.max(0, sentAt.getTime() - new Date(alert.ingestedAt).getTime()),
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

    // Instante do aceite pelo SNS (inclui timeout e retentativas do publish): base do SLO medido e do `published_at` no banco.
    const acceptedAt = this.now();
    metrics.increment('outbox_publish_total', { result: 'success' });
    metrics.observe('alert_latency_ms', Math.max(0, acceptedAt.getTime() - new Date(alert.ingestedAt).getTime()));
    try {
      await alerts.markPublished(alert.alertId, acceptedAt);
    } catch (err) {
      // Publicado, mas a marcação falhou: o relay republica e o SNS FIFO absorve a duplicata.
      logger.warn('alerta publicado, mas a marcação no outbox falhou', { alertId: alert.alertId, errorCode: errorCodeOf(err) });
    }
    return true;
  }
}
