import { DeclarativeRuleEngine } from '../../src/rules/declarative-rule-engine';
import { AppConfigRuleRepository } from '../../src/rules/appconfig-rule.repository';
import { ConfigPollResult, RuleConfigClient } from '../../src/rules/rule-source';
import { JsonLogger } from '../../src/observability/logger';
import { InMemoryMetrics } from '../../src/observability/metrics';
import { readExample } from './support';
import { TransactionEvent } from '../../src/transactions/transaction-event';

const doc = (ruleId: string, limit: number) =>
  JSON.stringify({
    rules: [
      {
        ruleId,
        name: ruleId,
        kind: 'STATELESS',
        severity: 'HIGH',
        weight: 40,
        mode: 'ACTIVE',
        params: { limitMinorUnits: limit },
        expression: 'tx.amount.minorUnits >= params.limitMinorUnits',
        reason: 'valor alto',
      },
    ],
  });

// Duas revisões que diferem em ruleId e em limite: um conjunto "misto" seria incoerente.
const REVISIONS = {
  1001: { content: doc('limit-low', 1_000_000), ruleId: 'limit-low', limit: 1_000_000 },
  1002: { content: doc('limit-high', 5_000_000), ruleId: 'limit-high', limit: 5_000_000 },
} as const;

/** Alterna entre as duas revisões a cada consulta. */
class AlternatingClient implements RuleConfigClient {
  private n = 0;
  swaps = 0;
  async start() {}
  async poll(): Promise<ConfigPollResult> {
    this.n += 1;
    const label = this.n % 2 === 1 ? 1001 : 1002;
    this.swaps += 1;
    return { kind: 'changed', content: REVISIONS[label].content, versionLabel: String(label) };
  }
}

describe('troca atômica do snapshot de regras (FR-008, SC-007)', () => {
  it('nenhuma avaliação mistura regras de duas revisões enquanto o snapshot é trocado', async () => {
    const client = new AlternatingClient();
    const engine = new DeclarativeRuleEngine();
    const repo = new AppConfigRuleRepository(client, engine, new JsonLogger(() => undefined), new InMemoryMetrics(), {
      pollIntervalMs: 2,
      startupTimeoutMs: 5000,
    });
    await repo.start();
    const tx = { ...readExample('transaction-event.authorized.valid.json'), amount: { minorUnits: 3_000_000, currency: 'BRL' } } as TransactionEvent;

    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) {
      // Como no ProcessTransactionService: o snapshot é lido uma vez e usado até o fim da avaliação.
      const snapshot = await repo.loadActiveSnapshot();
      await new Promise((resolve) => setImmediate(resolve)); // deixa a troca acontecer no meio da "avaliação"
      const expected = REVISIONS[snapshot.revision as 1001 | 1002];
      expect(snapshot.rules).toHaveLength(1);
      expect(snapshot.rules[0].ruleId).toBe(expected.ruleId);
      expect(snapshot.rules[0].params).toEqual({ limitMinorUnits: expected.limit });
      const matches = engine.evaluate(snapshot.rules, tx).map((m) => m.rule.ruleId);
      // 3.000.000 aciona o limite baixo (1.000.000), mas não o alto (5.000.000): o resultado segue a revisão lida.
      expect(matches).toEqual(expected.limit === 1_000_000 ? ['limit-low'] : []);
      seen.add(snapshot.revision);
    }
    repo.onModuleDestroy();

    expect(client.swaps).toBeGreaterThan(5);
    expect([...seen].sort()).toEqual([1001, 1002]);
  });
});
