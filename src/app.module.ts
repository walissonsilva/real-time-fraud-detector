import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config/config.module';
import { HealthModule } from './infrastructure/health/health.module';
import { PostgresModule } from './infrastructure/persistence/postgres.module';
import { RedisModule } from './infrastructure/cache/redis.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';

/**
 * Composition root: é aqui que as portas (application/ports) são ligadas aos
 * adaptadores (infrastructure/*). O domínio e a aplicação não importam NestJS.
 */
@Module({
  imports: [ConfigModule, ObservabilityModule, PostgresModule, RedisModule, HealthModule, MessagingModule],
})
export class AppModule {}
