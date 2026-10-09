import { Global, Module } from '@nestjs/common';
import { LOGGER, METRICS } from '../../application/ports/observability.port';
import { JsonLogger } from './logger';
import { InMemoryMetrics } from './metrics';

@Global()
@Module({
  providers: [
    { provide: LOGGER, useFactory: () => new JsonLogger() },
    { provide: METRICS, useClass: InMemoryMetrics },
  ],
  exports: [LOGGER, METRICS],
})
export class ObservabilityModule {}
