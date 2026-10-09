import { Rule } from './rule';

export interface RuleSnapshot {
  readonly revision: number;
  readonly rules: readonly Rule[];
}

/** Fonte de regras desta feature: snapshot imutável carregado na inicialização (FR-014a). */
export class StaticRuleRepository {
  constructor(private readonly snapshot: RuleSnapshot) {}

  async loadActiveSnapshot(): Promise<RuleSnapshot> {
    return this.snapshot;
  }

  async currentRevision(): Promise<number> {
    return this.snapshot.revision;
  }
}
