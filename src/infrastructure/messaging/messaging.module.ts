import { Module } from '@nestjs/common';
import { ALERT_REPOSITORY, AlertRepository } from '../../application/ports/alert-repository.port';
import { DLQ_PUBLISHER } from '../../application/ports/dlq-publisher.port';
import { EVENT_BUS, EventBus } from '../../application/ports/event-bus.port';
import { EVENT_VALIDATOR } from '../../application/ports/event-validator.port';
import { LOGGER, Logger, METRICS, Metrics } from '../../application/ports/observability.port';
import { RULE_ENGINE, RuleEngine } from '../../application/ports/rule-engine.port';
import { RULE_REPOSITORY, RuleRepository } from '../../application/ports/rule-repository.port';
import { OutboxEntryPublisher } from '../../application/use-cases/publish-outbox-entry';
import { ProcessTransaction } from '../../application/use-cases/process-transaction';
import { RelayOutbox } from '../../application/use-cases/relay-outbox';
import { AwsClientsModule } from '../aws/aws-clients.module';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { AjvTransactionEventValidator } from '../contracts/ajv-transaction-event.validator';
import { ObservabilityModule } from '../observability/observability.module';
import { DeclarativeRuleEngine } from '../rules/declarative-rule-engine';
import { loadRulesConfig } from '../rules/rules-config.loader';
import { StaticRuleRepository } from '../rules/static-rule.repository';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import { SnsEventBus } from './sns-event-bus';
import { SqsDlqPublisher } from './sqs-dlq.publisher';
import { SqsTransactionConsumer } from './sqs-transaction.consumer';

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
    SqsTransactionConsumer,
    OutboxRelayScheduler,
  ],
  exports: [SqsTransactionConsumer, OutboxRelayScheduler, RelayOutbox, ProcessTransaction],
})
export class MessagingModule {}
