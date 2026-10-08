import { Rule } from '../../domain/rule/rule';

export interface RuleSnapshot {
  readonly revision: number;
  readonly rules: readonly Rule[];
}

/** Fonte das regras ativas. A implementação mantém o último snapshot válido se o banco cair (ADR-05). */
export interface RuleRepository {
  loadActiveSnapshot(): Promise<RuleSnapshot>;
  currentRevision(): Promise<number>;
}
export const RULE_REPOSITORY = Symbol('RuleRepository');
