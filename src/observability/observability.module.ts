import { Global, Module } from '@nestjs/common';
import { JsonLogger } from './logger';
import { InMemoryMetrics } from './metrics';

@Global()
@Module({
  providers: [{ provide: JsonLogger, useFactory: () => new JsonLogger() }, InMemoryMetrics],
  exports: [JsonLogger, InMemoryMetrics],
})
export class ObservabilityModule {}
