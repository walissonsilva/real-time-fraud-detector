import { Money } from '../shared/money';
import { Severity } from '../rule/rule';

export interface TriggeredRule {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly name: string;
  readonly severity: Severity;
  readonly reason: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/** Espelha `FraudAlert v1` (docs/contratos). `dedupeKey` garante um alerta por transação (ADR-02). */
export interface FraudAlert {
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly transactionId: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly severity: Severity;
  readonly score: number;
  readonly status: 'OPEN';
  readonly triggeredRules: readonly TriggeredRule[];
  readonly amount: Money;
  readonly ingestedAt: string;
  readonly consumedAt: string;
  readonly detectedAt: string;
  readonly degraded: boolean;
  readonly late: boolean;
  readonly traceId?: string;
}
