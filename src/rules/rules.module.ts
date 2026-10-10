import { AppConfigDataClient } from '@aws-sdk/client-appconfigdata';
import { Module } from '@nestjs/common';
import { APPCONFIGDATA_CLIENT, AwsClientsModule } from '../aws/aws-clients.module';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { ObservabilityModule } from '../observability/observability.module';
import { AppConfigRuleClient } from './appconfig-rule.client';
import { AppConfigRuleRepository } from './appconfig-rule.repository';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { RULE_REPOSITORY, RuleRepository } from './rule-source';
import { loadRulesConfig } from './rules-config.loader';
import { StaticRuleRepository } from './static-rule.repository';

/**
 * Escolhe a fonte das regras por `RULES_SOURCE` e a prepara na criação do módulo:
 * - `file`: lê e valida `config/rules.json` (dev/testes);
 * - `appconfig`: abre a sessão e aguarda a primeira configuração válida, com retry até o prazo de partida.
 * Em ambos os casos, regras ausentes/inválidas lançam e o serviço NÃO inicia (FR-014b, FR-010).
 * Com `appconfig`, o arquivo de regras nunca é lido (FR-011).
 */
@Module({
  // Imports explícitos: o módulo é autossuficiente (os dois são globais no AppModule, mas não em módulos de teste).
  imports: [AwsClientsModule, ObservabilityModule],
  providers: [
    DeclarativeRuleEngine,
    {
      provide: RULE_REPOSITORY,
      inject: [DeclarativeRuleEngine, APP_CONFIG, APPCONFIGDATA_CLIENT, JsonLogger, InMemoryMetrics],
      useFactory: async (
        engine: DeclarativeRuleEngine,
        config: AppConfig,
        sdk: AppConfigDataClient,
        logger: JsonLogger,
        metrics: InMemoryMetrics,
      ): Promise<RuleRepository> => {
        if (config.rulesSource === 'file') {
          return new StaticRuleRepository(loadRulesConfig(config.rulesConfigPath, engine));
        }
        const client = new AppConfigRuleClient(sdk, config.appconfig, { requestTimeoutMs: config.rules.requestTimeoutMs });
        const repository = new AppConfigRuleRepository(client, engine, logger, metrics, {
          pollIntervalMs: config.rules.pollIntervalMs,
          startupTimeoutMs: config.rules.startupTimeoutMs,
        });
        await repository.start();
        return repository;
      },
    },
  ],
  exports: [DeclarativeRuleEngine, RULE_REPOSITORY],
})
export class RulesModule {}
