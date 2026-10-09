import { consolidate, WeightedMatch } from './decision';
import { Severity } from '../rule/rule';

const match = (ruleId: string, severity: Severity, weight: number): WeightedMatch => ({
  weight,
  triggered: { ruleId, ruleVersion: 1, name: ruleId, severity, reason: 'r' },
});

describe('consolidate', () => {
  it('sem regras acionadas → decisão vazia', () => {
    expect(consolidate([])).toEqual({ suspicious: false, score: 0, triggeredRules: [] });
  });

  it('severidade é a maior entre as acionadas', () => {
    expect(consolidate([match('a', 'LOW', 5), match('b', 'CRITICAL', 5), match('c', 'HIGH', 5)]).severity).toBe('CRITICAL');
    expect(consolidate([match('a', 'MEDIUM', 5), match('b', 'LOW', 5)]).severity).toBe('MEDIUM');
  });

  it('pontuação é a soma dos pesos', () => {
    expect(consolidate([match('a', 'LOW', 10), match('b', 'LOW', 25)]).score).toBe(35);
  });

  it('pontuação é limitada a 100', () => {
    expect(consolidate([match('a', 'LOW', 60), match('b', 'LOW', 70)]).score).toBe(100);
  });

  it('lista todas as regras acionadas em uma única decisão', () => {
    const d = consolidate([match('a', 'LOW', 1), match('b', 'LOW', 1), match('c', 'LOW', 1)]);
    expect(d.suspicious).toBe(true);
    expect(d.triggeredRules.map((r) => r.ruleId)).toEqual(['a', 'b', 'c']);
  });
});
