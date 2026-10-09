import { AlertRepository } from '../ports/alert-repository.port';
import { Logger, Metrics } from '../ports/observability.port';
import { OutboxEntryPublisher } from './publish-outbox-entry';

export interface RelayOutboxOptions {
  readonly batchSize: number;
  readonly minAgeMs: number;
  readonly leaseMs?: number;
}

/** Varre o outbox e republica pendentes (publicação imediata falhou ou o processo caiu após o commit). */
export class RelayOutbox {
  constructor(
    private readonly alerts: AlertRepository,
    private readonly publisher: OutboxEntryPublisher,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: RelayOutboxOptions,
  ) {}

  /** Retorna quantos alertas foram republicados com sucesso. */
  async runOnce(): Promise<number> {
    const entries = await this.alerts.claimPendingOutbox(this.options.batchSize, this.options.minAgeMs, this.options.leaseMs);
    let republished = 0;
    for (const entry of entries) {
      if (await this.publisher.publish(entry)) {
        republished++;
        this.metrics.increment('outbox_relay_republished_total');
      }
    }
    const { pending, oldestAgeMs } = await this.alerts.countPendingOutbox();
    this.metrics.gauge('outbox_pending', pending);
    this.metrics.gauge('outbox_oldest_pending_age_ms', oldestAgeMs);
    if (entries.length) this.logger.info('relay do outbox executado', { claimed: entries.length, republished, pending });
    return republished;
  }
}
