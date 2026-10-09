import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { OutboxEntryPublisherService } from './outbox-entry-publisher.service';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { AlertRepository } from './alert.repository';

@Injectable()
/** Varre o outbox e republica pendentes (publicação imediata falhou ou o processo caiu após o commit). */
export class RelayOutboxService {
  constructor(
    private readonly alerts: AlertRepository,
    private readonly publisher: OutboxEntryPublisherService,
    private readonly logger: JsonLogger,
    private readonly metrics: InMemoryMetrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Retorna quantos alertas foram republicados com sucesso. */
  async runOnce(): Promise<number> {
    const entries = await this.alerts.claimPendingOutbox(this.config.outboxRelay.batchSize, this.config.outboxRelay.minAgeMs);
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
