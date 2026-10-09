import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';

@Module({ imports: [AlertsModule], controllers: [HealthController, MetricsController] })
export class HealthModule {}
