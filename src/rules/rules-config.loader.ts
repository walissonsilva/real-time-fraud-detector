import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { RulesConfigError, validateRulesDocument } from './rules-document.validator';
import { RuleSnapshot } from './static-rule.repository';

export { RulesConfigError } from './rules-document.validator';

/**
 * Carrega, valida e congela a configuração de regras a partir de um arquivo (FR-014, FR-014b).
 * Qualquer problema lança `RulesConfigError`, que impede o serviço de iniciar.
 * A validação em si é `validateRulesDocument`, a mesma usada para o conteúdo vindo do AppConfig.
 */
export function loadRulesConfig(
  configPath: string,
  engine: DeclarativeRuleEngine,
  ruleSchemaPath?: string,
): RuleSnapshot {
  const file = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new RulesConfigError(`arquivo ausente ou ilegível (${configPath})`);
  }

  const { rules, documentRevision } = validateRulesDocument(raw, { engine, ruleSchemaPath });
  return Object.freeze({ revision: documentRevision ?? 1, rules });
}
