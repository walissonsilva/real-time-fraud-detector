import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { JsonLogger } from './logger';
import { InMemoryMetrics } from './metrics';
import { MetricsLogPublisher } from './metrics-log.publisher';

const METRICS_LOG_INTERVAL_MS = 60_000;

@Global()
@Module({
  providers: [
    { provide: JsonLogger, useFactory: () => new JsonLogger() },
    InMemoryMetrics,
    {
      provide: MetricsLogPublisher,
      inject: [InMemoryMetrics, APP_CONFIG],
      useFactory: (metrics: InMemoryMetrics, config: AppConfig) =>
        new MetricsLogPublisher(metrics, { enabled: config.rules.metricsLog, intervalMs: METRICS_LOG_INTERVAL_MS }),
    },
  ],
  exports: [JsonLogger, InMemoryMetrics],
})
export class ObservabilityModule {}
