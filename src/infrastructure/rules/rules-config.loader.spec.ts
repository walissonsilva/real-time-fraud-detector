import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { loadRulesConfig, RulesConfigError } from './rules-config.loader';

const root = join(__dirname, '../../..');
const example = (f: string) => JSON.parse(readFileSync(join(root, 'docs/contratos/examples', f), 'utf8'));

describe('loadRulesConfig', () => {
  const engine = new DeclarativeRuleEngine();
  const dir = mkdtempSync(join(tmpdir(), 'rules-'));
  let n = 0;
  const write = (content: string) => {
    const p = join(dir, `rules-${n++}.json`);
    writeFileSync(p, content);
    return p;
  };
  const load = (content: string) => loadRulesConfig(write(content), engine);

  it('carrega a configuração padrão do repositório (4 regras stateless)', () => {
    const snap = loadRulesConfig(join(root, 'config/rules.json'), engine);
    expect(snap.rules).toHaveLength(4);
    expect(snap.rules.every((r) => r.kind === 'STATELESS')).toBe(true);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('aceita a regra stateless de exemplo do contrato', () => {
    const snap = load(JSON.stringify({ rules: [example('rule.stateless.valid.json')].map((r) => ({ ...r, mode: 'ACTIVE' })) }));
    expect(snap.rules[0].ruleId).toBe('high-value-new-counterparty');
    expect(snap.rules[0].weight).toBe(25);
  });

  it('arquivo ausente', () => {
    expect(() => loadRulesConfig(join(dir, 'nao-existe.json'), engine)).toThrow(RulesConfigError);
  });

  it.each([
    ['JSON malformado', '{ rules: ['],
    ['sem lista rules', '{}'],
    ['lista vazia', '{"rules":[]}'],
    ['array no topo', '[]'],
  ])('rejeita %s', (_name, content) => {
    expect(() => load(content)).toThrow(RulesConfigError);
  });

  it('rejeita regra que viola Rule v1 (ruleId inválido)', () => {
    expect(() => load(JSON.stringify({ rules: [example('rule.bad-id.invalid.json')] }))).toThrow(/Rule v1/);
  });

  it('rejeita regra com janela/estado (WINDOWED)', () => {
    expect(() => load(JSON.stringify({ rules: [example('rule.windowed.valid.json')] }))).toThrow(/janela/);
  });

  it('rejeita regra STATELESS cuja expressão usa agg.*', () => {
    const rule = { ...example('rule.stateless.valid.json'), mode: 'ACTIVE', expression: 'agg.value > params.limitMinorUnits' };
    expect(() => load(JSON.stringify({ rules: [rule] }))).toThrow(/agg/);
  });

  it('rejeita regra com expressão sintaticamente inválida', () => {
    const rule = { ...example('rule.stateless.valid.json'), mode: 'ACTIVE', expression: 'tx.amount.minorUnits >=' };
    expect(() => load(JSON.stringify({ rules: [rule] }))).toThrow(RulesConfigError);
  });

  it('rejeita ruleId duplicado e ausência de regra ACTIVE', () => {
    const rule = { ...example('rule.stateless.valid.json'), mode: 'ACTIVE' };
    expect(() => load(JSON.stringify({ rules: [rule, rule] }))).toThrow(/duplicada/);
    expect(() => load(JSON.stringify({ rules: [{ ...rule, mode: 'SHADOW' }] }))).toThrow(/ACTIVE/);
  });

  it('mensagens de erro não ecoam valores do arquivo', () => {
    const rule = { ...example('rule.stateless.valid.json'), mode: 'ACTIVE', severity: 'SEGREDO-123' };
    expect.assertions(2);
    try {
      load(JSON.stringify({ rules: [rule] }));
    } catch (err) {
      expect(err).toBeInstanceOf(RulesConfigError);
      expect((err as Error).message).not.toContain('SEGREDO-123');
    }
  });
});
