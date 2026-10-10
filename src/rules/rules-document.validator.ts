import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { Rule } from './rule';

const RULE_SCHEMA_PATH = join(__dirname, '../../docs/contratos/rule.v1.schema.json');

export class RulesConfigError extends Error {
  constructor(message: string) {
    super(`Configuração de regras inválida: ${message}`);
    this.name = 'RulesConfigError';
  }
}

export interface ValidatedRulesDocument {
  readonly rules: readonly Rule[];
  /** Campo `revision` do documento, quando presente (só vale na fonte por arquivo). */
  readonly documentRevision?: number;
}

export interface ValidateRulesDocumentDeps {
  readonly engine: DeclarativeRuleEngine;
  readonly ruleSchemaPath?: string;
}

const schemaValidators = new Map<string, ValidateFunction>();

function ruleSchemaValidator(path: string): ValidateFunction {
  let validate = schemaValidators.get(path);
  if (!validate) {
    const ajv = new Ajv2020({ strict: false, allowUnionTypes: true, allErrors: false });
    addFormats(ajv);
    validate = ajv.compile(JSON.parse(readFileSync(path, 'utf8')));
    schemaValidators.set(path, validate);
  }
  return validate;
}

/**
 * Valida o conteúdo de um documento de regras (RulesDocument v1) e devolve as regras congeladas (FR-006).
 * Função pura em relação ao conteúdo: usada pela fonte por arquivo, pelo AppConfig e pelo script de publicação.
 * Qualquer problema lança `RulesConfigError`; as mensagens citam apenas posição, ruleId e a regra violada,
 * nunca valores do documento (FR-015).
 */
export function validateRulesDocument(content: string, deps: ValidateRulesDocumentDeps): ValidatedRulesDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RulesConfigError('o documento não é JSON válido');
  }

  const doc = parsed as { revision?: unknown; rules?: unknown } | null;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) {
    throw new RulesConfigError("esperado um objeto com a lista 'rules'");
  }
  if (doc.rules.length === 0) throw new RulesConfigError("a lista 'rules' está vazia");

  const validateSchema = ruleSchemaValidator(deps.ruleSchemaPath ?? RULE_SCHEMA_PATH);

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
      deps.engine.validate(rule);
    } catch (err) {
      throw new RulesConfigError((err as Error).message);
    }
    return Object.freeze(rule);
  });

  if (!rules.some((r) => r.mode === 'ACTIVE')) {
    throw new RulesConfigError('nenhuma regra com mode ACTIVE');
  }

  return Object.freeze({
    rules: Object.freeze(rules),
    ...(typeof doc.revision === 'number' ? { documentRevision: doc.revision } : {}),
  });
}
