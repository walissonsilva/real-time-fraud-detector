import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { loadRulesConfig } from './rules-config.loader';
import { StaticRuleRepository } from './static-rule.repository';

/**
 * Carrega e valida as regras na criação do módulo: configuração ausente/malformada/inválida lança e
 * o serviço NÃO inicia (FR-014b).
 */
@Module({
  providers: [
    DeclarativeRuleEngine,
    {
      provide: StaticRuleRepository,
      inject: [DeclarativeRuleEngine, APP_CONFIG],
      useFactory: (engine: DeclarativeRuleEngine, config: AppConfig) =>
        new StaticRuleRepository(loadRulesConfig(config.rulesConfigPath, engine)),
    },
  ],
  exports: [DeclarativeRuleEngine, StaticRuleRepository],
})
export class RulesModule {}
