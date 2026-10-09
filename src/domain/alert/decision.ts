import { Severity } from '../rule/rule';
import { TriggeredRule } from './fraud-alert';

export interface FraudDecision {
  readonly suspicious: boolean;
  readonly severity?: Severity;
  readonly score: number;
  readonly triggeredRules: readonly TriggeredRule[];
}

export interface WeightedMatch {
  readonly triggered: TriggeredRule;
  readonly weight: number;
}

const SEVERITY_ORDER: readonly Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const MAX_SCORE = 100;

/** Severidade = maior entre as regras acionadas; pontuação = soma dos pesos, limitada a 100 (FR-013). */
export function consolidate(matches: readonly WeightedMatch[]): FraudDecision {
  if (matches.length === 0) return { suspicious: false, score: 0, triggeredRules: [] };
  const severity = matches
    .map((m) => m.triggered.severity)
    .reduce((max, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(max) ? s : max));
  const score = Math.min(MAX_SCORE, matches.reduce((sum, m) => sum + m.weight, 0));
  return { suspicious: true, severity, score, triggeredRules: matches.map((m) => m.triggered) };
}
