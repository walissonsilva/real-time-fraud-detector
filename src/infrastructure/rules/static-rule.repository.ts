import { RuleRepository, RuleSnapshot } from '../../application/ports/rule-repository.port';

/** Fonte de regras desta feature: snapshot imutável carregado na inicialização (FR-014a). */
export class StaticRuleRepository implements RuleRepository {
  constructor(private readonly snapshot: RuleSnapshot) {}

  async loadActiveSnapshot(): Promise<RuleSnapshot> {
    return this.snapshot;
  }

  async currentRevision(): Promise<number> {
    return this.snapshot.revision;
  }
}
