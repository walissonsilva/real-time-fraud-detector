import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { RulesConfigError, validateRulesDocument } from './rules-document.validator';

const root = join(__dirname, '../..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const example = (f: string) => JSON.parse(read(`docs/contratos/examples/${f}`));

describe('validateRulesDocument', () => {
  const engine = new DeclarativeRuleEngine();
  const validate = (doc: unknown) => validateRulesDocument(typeof doc === 'string' ? doc : JSON.stringify(doc), { engine });
  const rule = () => ({ ...example('rule.stateless.valid.json'), mode: 'ACTIVE' });

  it('aceita o config/rules.json do repositório (4 regras stateless, congeladas)', () => {
    const result = validate(read('config/rules.json'));
    expect(result.rules).toHaveLength(4);
    expect(result.rules.every((r) => r.kind === 'STATELESS')).toBe(true);
    expect(Object.isFrozen(result.rules)).toBe(true);
    expect(Object.isFrozen(result.rules[0])).toBe(true);
    expect(result.documentRevision).toBe(1);
  });

  it('aceita o exemplo válido do contrato RulesDocument v1', () => {
    expect(validate(example('rules-document.stateless.valid.json')).rules).toHaveLength(4);
  });

  it('devolve documentRevision apenas quando o documento traz um inteiro', () => {
    expect(validate({ rules: [rule()] }).documentRevision).toBeUndefined();
    expect(validate({ revision: 7, rules: [rule()] }).documentRevision).toBe(7);
  });

  it.each([
    ['JSON ilegível', '{ rules: ['],
    ['objeto sem rules', '{}'],
    ['array no topo', '[]'],
    ['lista vazia', '{"rules":[]}'],
  ])('rejeita %s', (_name, content) => {
    expect(() => validate(content)).toThrow(RulesConfigError);
  });

  it('rejeita regra fora do contrato Rule v1', () => {
    expect(() => validate({ rules: [example('rule.bad-id.invalid.json')] })).toThrow(/Rule v1/);
  });

  it('rejeita regra WINDOWED ou com window (fase 1)', () => {
    expect(() => validate({ rules: [example('rule.windowed.valid.json')] })).toThrow(/janela/);
  });

  it('rejeita expressão que usa agg.* ou não compila', () => {
    expect(() => validate({ rules: [{ ...rule(), expression: 'agg.value > params.limitMinorUnits' }] })).toThrow(/agg/);
    expect(() => validate({ rules: [{ ...rule(), expression: 'tx.amount.minorUnits >=' }] })).toThrow(RulesConfigError);
  });

  it('rejeita ruleId duplicado e ausência de regra ACTIVE', () => {
    expect(() => validate({ rules: [rule(), rule()] })).toThrow(/duplicada/);
    expect(() => validate({ rules: [{ ...rule(), mode: 'SHADOW' }] })).toThrow(/ACTIVE/);
  });

  it('mensagens citam ruleId/posição e a regra violada, nunca valores do documento (FR-015)', () => {
    expect.assertions(4);
    try {
      validate({ rules: [{ ...rule(), severity: 'SEGREDO-123' }] });
    } catch (err) {
      expect(err).toBeInstanceOf(RulesConfigError);
      expect((err as Error).message).not.toContain('SEGREDO-123');
    }
    try {
      validate({ rules: [{ ...rule(), expression: 'tx.amount.minorUnits >= SEGREDO-456' }] });
    } catch (err) {
      expect(err).toBeInstanceOf(RulesConfigError);
      expect((err as Error).message).not.toContain('SEGREDO-456');
    }
  });
});
