import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { RuleEngine } from '../../application/ports/rule-engine.port';
import { RuleSnapshot } from '../../application/ports/rule-repository.port';
import { Rule } from '../../domain/rule/rule';

const RULE_SCHEMA_PATH = join(__dirname, '../../../docs/contratos/rule.v1.schema.json');

export class RulesConfigError extends Error {
  constructor(message: string) {
    super(`Configuração de regras inválida: ${message}`);
    this.name = 'RulesConfigError';
  }
}

/**
 * Carrega, valida e congela a configuração de regras (FR-014, FR-014b).
 * Qualquer problema lança `RulesConfigError`, que impede o serviço de iniciar.
 * As mensagens citam apenas ruleId, caminho e regra violada, nunca valores.
 */
export function loadRulesConfig(
  configPath: string,
  engine: RuleEngine,
  ruleSchemaPath: string = RULE_SCHEMA_PATH,
): RuleSnapshot {
  const file = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new RulesConfigError(`arquivo ausente ou ilegível (${configPath})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RulesConfigError('o arquivo não é JSON válido');
  }

  const doc = parsed as { revision?: unknown; rules?: unknown } | null;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) {
    throw new RulesConfigError("esperado um objeto com a lista 'rules'");
  }
  if (doc.rules.length === 0) throw new RulesConfigError("a lista 'rules' está vazia");

  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, allErrors: false });
  addFormats(ajv);
  const validateSchema = ajv.compile(JSON.parse(readFileSync(ruleSchemaPath, 'utf8')));

  const seen = new Set<string>();
  const rules: Rule[] = doc.rules.map((entry: unknown, index: number) => {
    const label = `regra #${index + 1}`;
    if (!validateSchema(entry)) {
      const [err] = validateSchema.errors ?? [];
      const where = err ? `${err.instancePath || '/'}: ${err.keyword}` : 'inválida';
      throw new RulesConfigError(`${label} viola o contrato Rule v1 (${where})`);
    }
    const r = entry as Record<string, unknown>;
    const ruleId = r.ruleId as string;
    if (seen.has(ruleId)) throw new RulesConfigError(`regra '${ruleId}' duplicada`);
    seen.add(ruleId);
    if (r.kind === 'WINDOWED' || r.window !== undefined) {
      throw new RulesConfigError(`regra '${ruleId}' depende de estado/janela e não é permitida (FR-014)`);
    }
    const rule: Rule = {
      ruleId,
      version: (r.version as number | undefined) ?? 1,
      name: r.name as string,
      kind: 'STATELESS',
      severity: r.severity as Rule['severity'],
      weight: (r.weight as number | undefined) ?? 10,
      mode: r.mode as Rule['mode'],
      params: (r.params as Rule['params'] | undefined) ?? {},
      expression: r.expression as string,
      reason: (r.reason as string | undefined) ?? (r.name as string),
      ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
    } as Rule;
    try {
      engine.validate(rule);
    } catch (err) {
      throw new RulesConfigError((err as Error).message);
    }
    return Object.freeze(rule);
  });

  if (!rules.some((r) => r.mode === 'ACTIVE')) {
    throw new RulesConfigError('nenhuma regra com mode ACTIVE');
  }

  const revision = typeof doc.revision === 'number' ? doc.revision : 1;
  return Object.freeze({ revision, rules: Object.freeze(rules) });
}
