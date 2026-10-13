import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { DlqModule } from '../dlq/dlq.module';
import { JsonLogger } from '../observability/logger';
import { AntifraudQueueProvider } from './channels/antifraud-queue.provider';
import { CustomerPushProvider } from './channels/customer-push.provider';
import { CustomerSmsProvider } from './channels/customer-sms.provider';
import { ChannelConsumers } from './channel-consumers';
import { DeliverAlertService } from './deliver-alert.service';
import { DeliveryRepository } from './delivery.repository';
import { NOTIFICATION_PROVIDERS, NotificationProvider } from './notification-provider';

/** Chaves de falha dos provedores simulados; mutáveis em tempo de execução (demonstração e testes e2e). */
export const CHANNEL_FAULTS = Symbol('CHANNEL_FAULTS');
export interface ChannelFaults {
  antifraud: boolean;
  customer: boolean;
  sms: boolean;
}

@Module({
  imports: [DlqModule],
  providers: [
    DeliveryRepository,
    {
      provide: CHANNEL_FAULTS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ChannelFaults => ({
        antifraud: config.channels.failAntifraud,
        customer: config.channels.failCustomer,
        sms: config.channels.failSms,
      }),
    },
    {
      provide: NOTIFICATION_PROVIDERS,
      inject: [JsonLogger, CHANNEL_FAULTS],
      // O SMS é só fallback do push: não tem fila nem consumidor.
      useFactory: (logger: JsonLogger, faults: ChannelFaults): NotificationProvider[] => [
        new AntifraudQueueProvider(logger, () => faults.antifraud),
        new CustomerPushProvider(logger, () => faults.customer, new CustomerSmsProvider(logger, () => faults.sms)),
      ],
    },
    DeliverAlertService,
    ChannelConsumers,
  ],
  exports: [ChannelConsumers, CHANNEL_FAULTS, NOTIFICATION_PROVIDERS, DeliverAlertService],
})
export class DeliveriesModule {}
