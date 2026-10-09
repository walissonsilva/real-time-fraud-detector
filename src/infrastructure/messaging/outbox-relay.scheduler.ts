import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { LOGGER, Logger } from '../../application/ports/observability.port';
import { RelayOutbox } from '../../application/use-cases/relay-outbox';
import { safeError } from '../observability/logger';
import { APP_CONFIG, AppConfig } from '../config/config.module';

/** Executa o relay em intervalo fixo, sem sobreposição entre execuções. */
@Injectable()
export class OutboxRelayScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private current?: Promise<void>;

  constructor(
    private readonly relay: RelayOutbox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.consumers.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.outboxRelay.intervalMs);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.current = this.relay
      .runOnce()
      .then(() => undefined)
      .catch((err: unknown) => this.logger.error('falha na execução do relay do outbox', safeError(err)))
      .finally(() => {
        this.running = false;
      });
    await this.current;
  }
}
