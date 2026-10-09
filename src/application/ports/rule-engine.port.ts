import { Rule } from '../../domain/rule/rule';
import { TransactionEvent } from '../../domain/transaction/transaction-event';

export interface RuleMatch {
  readonly rule: Rule;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
  /** Explicação legível, com os `{placeholders}` já resolvidos e sem PII. */
  readonly reason?: string;
}

/**
 * Valida e avalia expressões sem `eval` (ADR-03: CEL ou JSON Logic, em aberto).
 * `validate` lança erro se a regra for inválida ou depender de estado/janela (FR-014).
 */
export interface RuleEngine {
  validate(rule: Rule): void;
  evaluate(rules: readonly Rule[], tx: TransactionEvent): RuleMatch[];
}
export const RULE_ENGINE = Symbol('RuleEngine');
