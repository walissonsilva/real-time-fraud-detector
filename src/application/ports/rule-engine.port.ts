import { Rule } from '../../domain/rule/rule';
import { TransactionEvent } from '../../domain/transaction/transaction-event';

export interface RuleMatch {
  readonly rule: Rule;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/** Valida e avalia expressões sem `eval` (ADR-03: CEL ou JSON Logic, em aberto). */
export interface RuleEngine {
  validate(rule: Rule): void;
  evaluate(rules: readonly Rule[], tx: TransactionEvent): RuleMatch[];
}
export const RULE_ENGINE = Symbol('RuleEngine');
