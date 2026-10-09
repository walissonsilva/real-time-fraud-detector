import { Module } from '@nestjs/common';
import { AlertsModule } from './alerts/alerts.module';
import { AwsClientsModule } from './aws/aws-clients.module';
import { RedisModule } from './cache/redis.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { DlqModule } from './dlq/dlq.module';
import { HealthModule } from './health/health.module';
import { ObservabilityModule } from './observability/observability.module';
import { RulesModule } from './rules/rules.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    DatabaseModule,
    AwsClientsModule,
    RedisModule,
    HealthModule,
    RulesModule,
    DlqModule,
    AlertsModule,
    TransactionsModule,
    DeliveriesModule,
  ],
})
export class AppModule {}
