import { Inject, Injectable, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ALERT_REPOSITORY, AlertRepository } from '../../application/ports/alert-repository.port';
import { DELIVERY_REPOSITORY, DeliveryRepository } from '../../application/ports/delivery-repository.port';
import { DLQ_PUBLISHER, DlqPublisher } from '../../application/ports/dlq-publisher.port';
import { EVENT_BUS, EventBus } from '../../application/ports/event-bus.port';
import { EVENT_VALIDATOR } from '../../application/ports/event-validator.port';
import { LOGGER, Logger, METRICS, Metrics } from '../../application/ports/observability.port';
import { NOTIFICATION_PROVIDERS, NotificationProvider } from '../../application/ports/notification-provider.port';
import { RULE_ENGINE, RuleEngine } from '../../application/ports/rule-engine.port';
import { RULE_REPOSITORY, RuleRepository } from '../../application/ports/rule-repository.port';
import { OutboxEntryPublisher } from '../../application/use-cases/publish-outbox-entry';
import { ProcessTransaction } from '../../application/use-cases/process-transaction';
import { DeliverAlert } from '../../application/use-cases/deliver-alert';
import { RejectInvalidEvent } from '../../application/use-cases/reject-invalid-event';
import { RelayOutbox } from '../../application/use-cases/relay-outbox';
import { AwsClientsModule, SQS_CLIENT } from '../aws/aws-clients.module';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { AntifraudQueueProvider } from '../channels/antifraud-queue.provider';
import { CustomerPushProvider } from '../channels/customer-push.provider';
import { AjvTransactionEventValidator } from '../contracts/ajv-transaction-event.validator';
import { ObservabilityModule } from '../observability/observability.module';
import { DeclarativeRuleEngine } from '../rules/declarative-rule-engine';
import { loadRulesConfig } from '../rules/rules-config.loader';
import { StaticRuleRepository } from '../rules/static-rule.repository';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import { SqsChannelConsumer } from './sqs-channel.consumer';
import { SnsEventBus } from './sns-event-bus';
import { SqsDlqPublisher } from './sqs-dlq.publisher';
import { SqsTransactionConsumer } from './sqs-transaction.consumer';

/** Chaves de falha dos provedores simulados; mutáveis em tempo de execução (demonstração e testes e2e). */
export const CHANNEL_FAULTS = Symbol('CHANNEL_FAULTS');
export interface ChannelFaults {
  antifraud: boolean;
  customer: boolean;
}

/** Sobe um consumidor independente por canal (FR-021). */
@Injectable()
export class ChannelConsumers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumers: SqsChannelConsumer[];

  constructor(
    @Inject(SQS_CLIENT) sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NOTIFICATION_PROVIDERS) providers: NotificationProvider[],
    deliver: DeliverAlert,
    @Inject(DLQ_PUBLISHER) dlq: DlqPublisher,
    @Inject(LOGGER) logger: Logger,
    @Inject(METRICS) metrics: Metrics,
  ) {
    const queues: Record<string, { queue: string; dlqQueue: string }> = {
      ANTIFRAUD_QUEUE: { queue: config.queues.antifraudChannel, dlqQueue: config.queues.antifraudChannelDlq },
      PUSH: { queue: config.queues.customerChannel, dlqQueue: config.queues.customerChannelDlq },
    };
    this.consumers = providers.map(
      (p) =>
        new SqsChannelConsumer(sqs, p, deliver, dlq, logger, metrics, { ...queues[p.channel], pollers: config.consumers.channelPollers }),
    );
  }

  async onApplicationBootstrap() {
    if (this.config.consumers.enabled && this.config.consumers.channelsEnabled) await Promise.all(this.consumers.map((c) => c.start()));
  }

  async onApplicationShutdown() {
    await Promise.all(this.consumers.map((c) => c.stop()));
  }
}

/**
 * Composição do caminho de detecção. O RULE_REPOSITORY carrega e valida as regras na criação do
 * módulo: configuração ausente/malformada/inválida lança e o serviço NÃO inicia (FR-014b).
 */
@Module({
  imports: [AwsClientsModule, ObservabilityModule],
  providers: [
    { provide: EVENT_VALIDATOR, useFactory: () => new AjvTransactionEventValidator() },
    { provide: RULE_ENGINE, useClass: DeclarativeRuleEngine },
    {
      provide: RULE_REPOSITORY,
      inject: [RULE_ENGINE, APP_CONFIG],
      useFactory: (engine: RuleEngine, config: AppConfig) =>
        new StaticRuleRepository(loadRulesConfig(config.rulesConfigPath, engine)),
    },
    { provide: EVENT_BUS, useClass: SnsEventBus },
    { provide: DLQ_PUBLISHER, useClass: SqsDlqPublisher },
    {
      provide: OutboxEntryPublisher,
      inject: [ALERT_REPOSITORY, EVENT_BUS, LOGGER, METRICS],
      useFactory: (alerts: AlertRepository, bus: EventBus, logger: Logger, metrics: Metrics) =>
        new OutboxEntryPublisher({ alerts, bus, logger, metrics }),
    },
    {
      provide: ProcessTransaction,
      inject: [RULE_REPOSITORY, RULE_ENGINE, ALERT_REPOSITORY, OutboxEntryPublisher, LOGGER, METRICS],
      useFactory: (
        rules: RuleRepository,
        engine: RuleEngine,
        alerts: AlertRepository,
        publisher: OutboxEntryPublisher,
        logger: Logger,
        metrics: Metrics,
      ) => new ProcessTransaction({ rules, engine, alerts, publisher, logger, metrics }),
    },
    {
      provide: RejectInvalidEvent,
      inject: [DLQ_PUBLISHER, APP_CONFIG, LOGGER, METRICS],
      useFactory: (dlq: DlqPublisher, config: AppConfig, logger: Logger, metrics: Metrics) =>
        new RejectInvalidEvent({ dlq, dlqQueue: config.queues.transactionsDlq, source: config.queues.transactions, logger, metrics }),
    },
    {
      provide: RelayOutbox,
      inject: [ALERT_REPOSITORY, OutboxEntryPublisher, LOGGER, METRICS, APP_CONFIG],
      useFactory: (
        alerts: AlertRepository,
        publisher: OutboxEntryPublisher,
        logger: Logger,
        metrics: Metrics,
        config: AppConfig,
      ) => new RelayOutbox(alerts, publisher, logger, metrics, config.outboxRelay),
    },
    {
      provide: CHANNEL_FAULTS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ChannelFaults => ({
        antifraud: config.channels.failAntifraud,
        customer: config.channels.failCustomer,
      }),
    },
    {
      provide: NOTIFICATION_PROVIDERS,
      inject: [LOGGER, CHANNEL_FAULTS],
      useFactory: (logger: Logger, faults: ChannelFaults): NotificationProvider[] => [
        new AntifraudQueueProvider(logger, () => faults.antifraud),
        new CustomerPushProvider(logger, () => faults.customer),
      ],
    },
    {
      provide: DeliverAlert,
      inject: [DELIVERY_REPOSITORY, DLQ_PUBLISHER, APP_CONFIG, LOGGER, METRICS],
      useFactory: (deliveries: DeliveryRepository, dlq: DlqPublisher, config: AppConfig, logger: Logger, metrics: Metrics) =>
        new DeliverAlert({
          deliveries,
          dlq,
          dlqQueues: { ANTIFRAUD_QUEUE: config.queues.antifraudChannelDlq, PUSH: config.queues.customerChannelDlq },
          logger,
          metrics,
          retryOptions: {
            attempts: config.channels.maxAttempts,
            baseDelayMs: config.channels.baseDelayMs,
            maxDelayMs: config.channels.maxDelayMs,
            timeoutMs: config.channels.sendTimeoutMs,
          },
        }),
    },
    ChannelConsumers,
    SqsTransactionConsumer,
    OutboxRelayScheduler,
  ],
  exports: [ChannelConsumers, CHANNEL_FAULTS, DeliverAlert, SqsTransactionConsumer, OutboxRelayScheduler, RelayOutbox, ProcessTransaction],
})
export class MessagingModule {}
