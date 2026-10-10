import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { AppConfigRuleRepository, AppConfigRuleRepositoryOptions } from './appconfig-rule.repository';
import { loadRulesConfig } from './rules-config.loader';
import { ConfigClientError, ConfigPollResult, RuleConfigClient } from './rule-source';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { TransactionEvent } from '../transactions/transaction-event';

const root = join(__dirname, '../..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const rulesJson = read('config/rules.json');
const doc = (limit: number) =>
  JSON.stringify({
    rules: [
      {
        ruleId: 'high-amount',
        name: 'Valor alto',
        kind: 'STATELESS',
        severity: 'HIGH',
        weight: 40,
        mode: 'ACTIVE',
        params: { limitMinorUnits: limit },
        expression: 'tx.amount.minorUnits >= params.limitMinorUnits',
        reason: 'Valor alto',
      },
    ],
  });
const changed = (content: string, versionLabel?: string): ConfigPollResult => ({ kind: 'changed', content, versionLabel });
const UNCHANGED: ConfigPollResult = { kind: 'unchanged' };

/** Cliente falso: devolve respostas enfileiradas; depois da fila, "unchanged". */
class FakeClient implements RuleConfigClient {
  starts = 0;
  polls = 0;
  private queue: Array<ConfigPollResult | Error> = [];
  push(...items: Array<ConfigPollResult | Error>) {
    this.queue.push(...items);
    return this;
  }
  async start() {
    this.starts += 1;
  }
  async poll(): Promise<ConfigPollResult> {
    this.polls += 1;
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? UNCHANGED;
  }
}

const OPTIONS: AppConfigRuleRepositoryOptions = { pollIntervalMs: 20_000, startupTimeoutMs: 45_000 };

function setup(client: FakeClient, options: Partial<AppConfigRuleRepositoryOptions> = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger((l) => lines.push(JSON.parse(l)));
  const metrics = new InMemoryMetrics();
  const engine = new DeclarativeRuleEngine();
  const repo = new AppConfigRuleRepository(client, engine, logger, metrics, { ...OPTIONS, ...options }, { random: () => 0.5 });
  return { repo, lines, metrics, engine };
}

describe('AppConfigRuleRepository', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('US1: aplicar nova revisão sem reinício', () => {
    it('start() ativa a primeira configuração e a revisão vem do rótulo de versão', async () => {
      const client = new FakeClient().push(changed(rulesJson, '20261010120000'));
      const { repo } = setup(client);
      await repo.start();
      expect(await repo.currentRevision()).toBe(20261010120000);
      const snap = await repo.loadActiveSnapshot();
      expect(snap.rules).toHaveLength(4);
      expect(snap.revision).toBe(20261010120000);
      repo.onModuleDestroy();
    });

    it('um "changed" válido troca o snapshot e atualiza a revisão; "unchanged" mantém', async () => {
      const client = new FakeClient().push(changed(doc(1000), '20261010120000'), UNCHANGED, changed(doc(2000), '20261010130000'));
      const { repo } = setup(client);
      await repo.start();
      const first = await repo.loadActiveSnapshot();
      await jest.advanceTimersByTimeAsync(20_000); // unchanged
      expect(await repo.loadActiveSnapshot()).toBe(first);
      await jest.advanceTimersByTimeAsync(20_000); // changed
      const second = await repo.loadActiveSnapshot();
      expect(second).not.toBe(first);
      expect(second.revision).toBe(20261010130000);
      expect(second.rules[0].params).toEqual({ limitMinorUnits: 2000 });
      repo.onModuleDestroy();
    });

    it('consulta a cada ~20 s com jitter de ±10%', async () => {
      const client = new FakeClient().push(changed(rulesJson, '1'));
      const lowJitter = setup(client, {}).repo; // random=0.5 => sem desvio
      await lowJitter.start();
      await jest.advanceTimersByTimeAsync(19_999);
      expect(client.polls).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(client.polls).toBe(2);
      lowJitter.onModuleDestroy();

      for (const [rnd, expected] of [[0, 18_000], [1, 22_000]] as const) {
        const c = new FakeClient().push(changed(rulesJson, '1'));
        const repo = new AppConfigRuleRepository(c, new DeclarativeRuleEngine(), new JsonLogger(() => undefined), new InMemoryMetrics(), OPTIONS, { random: () => rnd });
        await repo.start();
        await jest.advanceTimersByTimeAsync(expected - 1);
        expect(c.polls).toBe(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(c.polls).toBe(2);
        repo.onModuleDestroy();
      }
    });

    it('o caminho crítico não chama o cliente: loadActiveSnapshot e currentRevision são só memória (FR-009)', async () => {
      const client = new FakeClient().push(changed(rulesJson, '5'));
      const { repo } = setup(client);
      await repo.start();
      const before = { starts: client.starts, polls: client.polls };
      for (let i = 0; i < 1000; i++) {
        await repo.loadActiveSnapshot();
        await repo.currentRevision();
      }
      expect({ starts: client.starts, polls: client.polls }).toEqual(before);
      repo.onModuleDestroy();
    });

    it('as duas fontes produzem a mesma decisão para o mesmo documento (FR-021)', async () => {
      const client = new FakeClient().push(changed(rulesJson, '9'));
      const { repo, engine } = setup(client);
      await repo.start();
      const fromAppConfig = (await repo.loadActiveSnapshot()).rules;
      const fromFile = loadRulesConfig(join(root, 'config/rules.json'), engine).rules;
      const txs = ['authorized', 'declined'].map((k) => JSON.parse(read(`docs/contratos/examples/transaction-event.${k}.valid.json`)) as TransactionEvent);
      txs.push({ ...txs[0], amount: { minorUnits: 5_000_000, currency: 'BRL' } });
      for (const tx of txs) {
        const ids = (rules: typeof fromFile) => engine.evaluate(rules, tx).map((m) => m.rule.ruleId);
        expect(ids(fromAppConfig)).toEqual(ids(fromFile));
      }
      repo.onModuleDestroy();
    });
  });

  describe('US3: documento inválido nunca entra em produção', () => {
    const bad: Array<[string, string]> = [
      ['fora do contrato Rule v1', JSON.stringify({ rules: [{ ruleId: 'X' }] })],
      ['JSON ilegível', '{ rules: ['],
      ['lista vazia', '{"rules":[]}'],
      ['regra WINDOWED', JSON.stringify({ rules: [{ ruleId: 'win-rule', name: 'w', kind: 'WINDOWED', severity: 'HIGH', mode: 'ACTIVE', expression: 'true', window: { groupBy: 'accountId', durationSeconds: 60, aggregation: 'COUNT' } }] })],
      ['expressão inválida', doc(1).replace('tx.amount.minorUnits >= params.limitMinorUnits', 'tx.amount.minorUnits >=')],
      ['sem regra ACTIVE', doc(1).replace('"ACTIVE"', '"SHADOW"')],
      ['ruleId duplicado', JSON.stringify({ rules: [JSON.parse(doc(1)).rules[0], JSON.parse(doc(2)).rules[0]] })],
    ];

    it.each(bad)('documento %s é rejeitado e o snapshot é mantido', async (_name, content) => {
      const client = new FakeClient().push(changed(doc(1000), '100'), changed(content, '101'));
      const { repo, lines, metrics } = setup(client);
      await repo.start();
      const before = await repo.loadActiveSnapshot();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(await repo.loadActiveSnapshot()).toBe(before);
      expect(await repo.currentRevision()).toBe(100);
      expect(metrics.counter('rules_refresh_failures_total')).toBe(1);
      expect(lines.some((l) => l.message === 'rules.document.rejected')).toBe(true);
      repo.onModuleDestroy();
    });

    it('conteúdo sem rótulo de versão numérico é rejeitado (revisão não rastreável)', async () => {
      for (const label of [undefined, '', 'abc', '-3', '1.5']) {
        const client = new FakeClient().push(changed(doc(1000), '100'), changed(doc(2000), label));
        const { repo, metrics } = setup(client);
        await repo.start();
        await jest.advanceTimersByTimeAsync(20_000);
        expect(await repo.currentRevision()).toBe(100);
        expect(metrics.counter('rules_refresh_failures_total')).toBe(1);
        repo.onModuleDestroy();
      }
    });

    it('o log de rejeição traz só ruleId e a regra violada, nunca valores do documento (FR-015)', async () => {
      const secret = doc(1).replace('"reason":"Valor alto"', '"reason":"SEGREDO-789"').replace('"HIGH"', '"SEGREDO-123"');
      const client = new FakeClient().push(changed(doc(1000), '100'), changed(secret, '101'));
      const { repo, lines } = setup(client);
      await repo.start();
      await jest.advanceTimersByTimeAsync(20_000);
      const rejected = lines.find((l) => l.message === 'rules.document.rejected');
      expect(rejected).toBeDefined();
      expect(JSON.stringify(lines)).not.toMatch(/SEGREDO/);
      repo.onModuleDestroy();
    });

    it('enquanto o último documento publicado estiver rejeitado, cada ciclo continua contando falha (alimenta o rollback)', async () => {
      const client = new FakeClient().push(changed(doc(1000), '100'), changed('{"rules":[]}', '101'), UNCHANGED, UNCHANGED);
      const { repo, metrics } = setup(client);
      await repo.start();
      await jest.advanceTimersByTimeAsync(20_000 * 3);
      expect(metrics.counter('rules_refresh_failures_total')).toBe(3);
      // O rollback do deployment devolve um documento válido: limpa o estado de rejeição.
      client.push(changed(doc(1000), '100'));
      await jest.advanceTimersByTimeAsync(20_000);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(metrics.counter('rules_refresh_failures_total')).toBe(3);
      repo.onModuleDestroy();
    });
  });

  describe('US4: continuar operando quando o serviço de configuração falha', () => {
    it('na partida, falhas transitórias são repetidas com backoff e a terceira tentativa ativa a configuração', async () => {
      const client = new FakeClient().push(new ConfigClientError('UNAVAILABLE'), new ConfigClientError('THROTTLED'), changed(rulesJson, '7'));
      const { repo } = setup(client);
      const started = repo.start();
      await jest.advanceTimersByTimeAsync(1_000); // 1ª espera
      expect(client.polls).toBe(2);
      await jest.advanceTimersByTimeAsync(2_000); // 2ª espera (dobra)
      await started;
      expect(client.polls).toBe(3);
      expect(await repo.currentRevision()).toBe(7);
      repo.onModuleDestroy();
    });

    it('esgotado o prazo de partida, start() rejeita com erro claro e registra rules.startup.failed', async () => {
      const client = new FakeClient();
      for (let i = 0; i < 50; i++) client.push(new ConfigClientError('UNAVAILABLE'));
      const { repo, lines } = setup(client);
      const started = repo.start();
      const assertion = expect(started).rejects.toThrow(/regras/);
      await jest.advanceTimersByTimeAsync(60_000);
      await assertion;
      const failed = lines.find((l) => l.message === 'rules.startup.failed');
      expect(failed).toBeDefined();
      expect(JSON.stringify(lines)).not.toMatch(/token/i);
    });

    it('na partida, documento inválido também falha ao esgotar o prazo (nunca ativa regra inválida)', async () => {
      const client = new FakeClient();
      for (let i = 0; i < 50; i++) client.push(changed('{"rules":[]}', '1'));
      const { repo } = setup(client);
      const started = repo.start();
      const assertion = expect(started).rejects.toThrow(/regras/);
      await jest.advanceTimersByTimeAsync(60_000);
      await assertion;
    });

    it('uma chamada que nunca responde não impede o esgotamento do prazo de partida', async () => {
      const hang: RuleConfigClient = { start: async () => undefined, poll: () => new Promise(() => undefined) };
      const repo = new AppConfigRuleRepository(hang, new DeclarativeRuleEngine(), new JsonLogger(() => undefined), new InMemoryMetrics(), OPTIONS, { random: () => 0.5 });
      const started = repo.start();
      const assertion = expect(started).rejects.toThrow(/regras/);
      await jest.advanceTimersByTimeAsync(60_000);
      await assertion;
    });

    it.each(['THROTTLED', 'UNAVAILABLE', 'ACCESS_DENIED', 'SESSION_EXPIRED', 'NOT_FOUND', 'UNKNOWN'] as const)(
      'em runtime, %s mantém o snapshot, conta a falha e o laço continua',
      async (category) => {
        const client = new FakeClient().push(changed(doc(1000), '100'), new ConfigClientError(category), changed(doc(2000), '101'));
        const { repo, metrics } = setup(client);
        await repo.start();
        const before = await repo.loadActiveSnapshot();
        await jest.advanceTimersByTimeAsync(20_000);
        expect(await repo.loadActiveSnapshot()).toBe(before);
        expect(metrics.counter('rules_refresh_failures_total')).toBe(1);
        await jest.advanceTimersByTimeAsync(20_000);
        expect(await repo.currentRevision()).toBe(101);
        repo.onModuleDestroy();
      },
    );

    it('uma chamada pendurada em runtime não impede os ciclos seguintes de serem agendados', async () => {
      let calls = 0;
      const client: RuleConfigClient = {
        start: async () => undefined,
        poll: async () => {
          calls += 1;
          if (calls === 1) return changed(doc(1000), '100');
          if (calls === 2) throw new ConfigClientError('UNAVAILABLE', 'timeout');
          return changed(doc(2000), '101');
        },
      };
      const repo = new AppConfigRuleRepository(client, new DeclarativeRuleEngine(), new JsonLogger(() => undefined), new InMemoryMetrics(), OPTIONS, { random: () => 0.5 });
      await repo.start();
      await jest.advanceTimersByTimeAsync(40_000);
      expect(await repo.currentRevision()).toBe(101);
      repo.onModuleDestroy();
    });

    it('onModuleDestroy cancela o laço', async () => {
      const client = new FakeClient().push(changed(rulesJson, '1'));
      const { repo } = setup(client);
      await repo.start();
      repo.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(client.polls).toBe(1);
    });
  });

  describe('US5: métricas e logs de defasagem', () => {
    it('expõe revisão ativa, idade do último refresh e total de falhas', async () => {
      const client = new FakeClient().push(changed(rulesJson, '42'), new ConfigClientError('UNAVAILABLE'), new ConfigClientError('UNAVAILABLE'));
      const { repo, metrics } = setup(client);
      await repo.start();
      expect(metrics.render()).toContain('rules_active_revision 42');
      expect(metrics.render()).toContain('rules_last_refresh_age_seconds 0');
      await jest.advanceTimersByTimeAsync(20_000);
      await jest.advanceTimersByTimeAsync(20_000);
      const text = metrics.render();
      expect(text).toContain('rules_refresh_failures_total 2');
      const age = Number(/rules_last_refresh_age_seconds (\d+(\.\d+)?)/.exec(text)?.[1]);
      expect(age).toBeGreaterThanOrEqual(20);
      repo.onModuleDestroy();
    });

    it('a idade zera a cada consulta bem-sucedida, inclusive "unchanged"', async () => {
      const client = new FakeClient().push(changed(rulesJson, '42'), new ConfigClientError('UNAVAILABLE'), UNCHANGED);
      const { repo, metrics } = setup(client);
      await repo.start();
      await jest.advanceTimersByTimeAsync(40_000);
      expect(metrics.render()).toContain('rules_last_refresh_age_seconds 0');
      repo.onModuleDestroy();
    });

    it('registra rules.refresh.ok na troca de revisão e rules.refresh.failed nas falhas, sem conteúdo do documento', async () => {
      const client = new FakeClient().push(changed(doc(1000), '100'), changed(doc(2000), '101'), new ConfigClientError('THROTTLED'));
      const { repo, lines } = setup(client);
      await repo.start();
      await jest.advanceTimersByTimeAsync(40_000);
      const ok = lines.find((l) => l.message === 'rules.refresh.ok');
      expect(ok).toMatchObject({ previousRevision: 100, revision: 101 });
      const failed = lines.find((l) => l.message === 'rules.refresh.failed');
      expect(failed).toMatchObject({ reason: 'THROTTLED' });
      expect(JSON.stringify(lines)).not.toContain('limitMinorUnits');
      repo.onModuleDestroy();
    });
  });
});
