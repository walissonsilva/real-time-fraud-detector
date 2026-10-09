import { Money } from '../shared/money';
import { Severity } from '../rule/rule';

export interface TriggeredRule {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly name: string;
  readonly severity: Severity;
  readonly reason: string;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
}

/** Resumo mascarado da transação (sem origem, sem identificadores do cliente). */
export interface TransactionSummary {
  readonly transactionType: string;
  readonly channel: string;
  readonly amount: Money;
  readonly counterpartyIdToken?: string;
  readonly merchantCountry?: string;
}

/**
 * Espelha `FraudAlert v1` (docs/contratos). `dedupeKey` garante um alerta por transação (ADR-02).
 * `publishedAt` e `latencyMs` só são preenchidos no instante da publicação (marco de latência, FR-018);
 * o payload gravado no outbox não os contém.
 */
export interface FraudAlert {
  readonly schemaVersion: '1.0';
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly transactionId: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly severity: Severity;
  readonly score: number;
  readonly status: 'OPEN';
  readonly triggeredRules: readonly TriggeredRule[];
  readonly transaction: TransactionSummary;
  readonly transactionOccurredAt: string;
  readonly ingestedAt: string;
  readonly consumedAt: string;
  readonly detectedAt: string;
  readonly publishedAt?: string;
  readonly latencyMs?: number;
  readonly degraded: boolean;
  readonly late: boolean;
  readonly traceId?: string;
}

/** Alerta já carimbado para publicação: o contrato exige `publishedAt`. */
export type PublishableFraudAlert = FraudAlert & { readonly publishedAt: string; readonly latencyMs: number };
