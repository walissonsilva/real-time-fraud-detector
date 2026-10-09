import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rule } from '../../domain/rule/rule';
import { TransactionEvent } from '../../domain/transaction/transaction-event';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { loadRulesConfig } from './rules-config.loader';

const root = join(__dirname, '../../..');
const engine = new DeclarativeRuleEngine();
const rules = loadRulesConfig(join(root, 'config/rules.json'), engine).rules;
const base = JSON.parse(
  readFileSync(join(root, 'docs/contratos/examples/transaction-event.authorized.valid.json'), 'utf8'),
) as TransactionEvent;

const tx = (patch: Record<string, unknown>): TransactionEvent => ({ ...base, ...patch }) as TransactionEvent;
const ids = (event: TransactionEvent, set: readonly Rule[] = rules) => engine.evaluate(set, event).map((m) => m.rule.ruleId);

const small = { minorUnits: 10_000, currency: 'BRL' };

describe('DeclarativeRuleEngine — regras de exemplo', () => {
  it('valor alto', () => {
    expect(ids(tx({ amount: { minorUnits: 1_000_000, currency: 'BRL' }, counterparty: { idToken: 'c', firstSeenAt: '2026-01-01T00:00:00Z' } }))).toEqual(['high-amount']);
    expect(ids(tx({ amount: { minorUnits: 999_999, currency: 'BRL' }, counterparty: undefined }))).toEqual([]);
  });

  it('contraparte nova com valor alto', () => {
    const e = tx({ amount: { minorUnits: 600_000, currency: 'BRL' }, counterparty: { idToken: 'cpt_1' } });
    expect(ids(e)).toEqual(['high-value-new-counterparty']);
    expect(ids(tx({ ...e, counterparty: { idToken: 'cpt_1', firstSeenAt: '2026-01-01T00:00:00Z' } }))).toEqual([]);
    expect(ids(tx({ ...e, counterparty: undefined }))).toEqual([]);
    expect(ids(tx({ ...e, amount: small }))).toEqual([]);
  });

  it('país do comerciante de risco', () => {
    const e = tx({ amount: small, counterparty: undefined, merchant: { id: 'm1', country: 'KP' } });
    expect(ids(e)).toEqual(['risky-merchant-country']);
    expect(ids(tx({ ...e, merchant: { id: 'm1', country: 'BR' } }))).toEqual([]);
    expect(ids(tx({ ...e, merchant: undefined }))).toEqual([]);
  });

  it('combinação incomum de canal e tipo', () => {
    const e = tx({ amount: small, counterparty: undefined, channel: 'ATM', transactionType: 'PIX' });
    expect(ids(e)).toEqual(['unusual-channel-transaction-type']);
    expect(ids(tx({ ...e, channel: 'MOBILE_APP' }))).toEqual([]);
    expect(ids(tx({ ...e, transactionType: 'CARD_WITHDRAWAL' }))).toEqual([]);
  });

  it('várias regras acionadas no mesmo evento', () => {
    const e = tx({ amount: { minorUnits: 2_000_000, currency: 'BRL' }, counterparty: { idToken: 'c' }, merchant: { country: 'IR' } });
    expect(ids(e).sort()).toEqual(['high-amount', 'high-value-new-counterparty', 'risky-merchant-country']);
  });

  it('evidências são primitivas e nunca incluem dados de origem (IP/geo)', () => {
    const e = tx({
      amount: { minorUnits: 2_000_000, currency: 'BRL' },
      origin: { ipAddress: '203.0.113.7', geo: { latitude: -23.5, longitude: -46.6 } },
    });
    const [m] = engine.evaluate(rules, e);
    expect(m.evidence).toEqual({ 'amount.minorUnits': 2_000_000 });
    expect(JSON.stringify(engine.evaluate(rules, e))).not.toContain('203.0.113.7');
    expect(m.reason).toContain('1000000');
  });
});

describe('DeclarativeRuleEngine — determinismo (FR-012, SC-003)', () => {
  const events = [
    tx({ amount: { minorUnits: 2_000_000, currency: 'BRL' } }),
    tx({ amount: small, counterparty: undefined, merchant: { country: 'SY' } }),
    tx({ amount: small, counterparty: undefined, channel: 'POS', transactionType: 'BOLETO' }),
    tx({ amount: small, counterparty: undefined }),
  ];

  it('mesmo evento → mesma decisão, em qualquer ordem e repetição', () => {
    const expected = events.map((e) => JSON.stringify(engine.evaluate(rules, e)));
    for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [0, 0, 1, 1, 2, 2, 3, 3]]) {
      for (const i of order) expect(JSON.stringify(engine.evaluate(rules, events[i]))).toBe(expected[i]);
    }
    const reversed = [...rules].reverse();
    for (const e of events) {
      expect(ids(e, reversed).sort()).toEqual(ids(e).sort());
    }
  });
});

describe('DeclarativeRuleEngine — validate', () => {
  const rule = (patch: Partial<Rule> & Record<string, unknown>): Rule =>
    ({ ruleId: 'r-test', version: 1, name: 'n', kind: 'STATELESS', severity: 'LOW', weight: 1, mode: 'ACTIVE', params: {}, expression: 'true', reason: 'x', ...patch }) as Rule;

  it('aceita expressão stateless', () => {
    expect(() => engine.validate(rule({ expression: 'tx.amount.minorUnits > 1 && !(tx.channel == "ATM")' }))).not.toThrow();
  });
  it('rejeita WINDOWED, window, agg.* e raízes desconhecidas', () => {
    expect(() => engine.validate(rule({ kind: 'WINDOWED' }))).toThrow(/STATELESS/);
    expect(() => engine.validate(rule({ window: { groupBy: 'accountId' } }))).toThrow(/janela/);
    expect(() => engine.validate(rule({ expression: 'agg.value > 1' }))).toThrow(/agg/);
    expect(() => engine.validate(rule({ expression: 'process.env.X == "a"' }))).toThrow(/process/);
  });
  it('rejeita sintaxe inválida', () => {
    expect(() => engine.validate(rule({ expression: '(tx.channel == "ATM"' }))).toThrow();
    expect(() => engine.validate(rule({ expression: 'tx.channel = "ATM"' }))).toThrow();
  });
  it('regras SHADOW não geram match e appliesTo filtra', () => {
    expect(engine.evaluate([rule({ mode: 'SHADOW' })], base)).toEqual([]);
    expect(engine.evaluate([rule({ appliesTo: { transactionTypes: ['TED'] } })], base)).toEqual([]);
    expect(engine.evaluate([rule({ appliesTo: { transactionTypes: ['PIX'] } })], base)).toHaveLength(1);
  });
});
