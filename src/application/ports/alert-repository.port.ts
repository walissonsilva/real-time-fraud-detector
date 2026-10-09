import { FraudAlert } from '../../domain/alert/fraud-alert';

/** Linha pendente do outbox: o alerta a publicar e o contexto de rastreamento. */
export interface OutboxEntry {
  readonly alert: FraudAlert;
  readonly traceparent?: string;
  readonly attempts: number;
}

/**
 * Persistência transacional do alerta + outbox (ADR-04).
 * Retorna `false` quando `dedupeKey` já existia (duplicata: nada é gravado).
 */
export interface AlertRepository {
  saveWithOutbox(alert: FraudAlert, traceparent?: string): Promise<boolean>;
  /** Idempotente: preserva o primeiro instante de publicação. */
  markPublished(alertId: string, publishedAt: Date): Promise<void>;
  /** Registra falha de publicação (sem PII) e agenda a próxima tentativa com backoff. */
  recordPublishFailure(alertId: string, errorCode: string): Promise<void>;
  /**
   * Para o relay: reivindica pendentes criados há mais de `olderThanMs` e cuja próxima tentativa já venceu.
   * Usa `FOR UPDATE SKIP LOCKED` e um lease (`next_attempt_at`) para que instâncias concorrentes não
   * processem a mesma linha.
   */
  claimPendingOutbox(limit: number, olderThanMs: number, leaseMs?: number): Promise<OutboxEntry[]>;
  /** Para reentrega do evento de entrada (FR-017a): a linha do outbox do alerta existente, se ainda pendente. */
  findPendingByDedupeKey(dedupeKey: string): Promise<OutboxEntry | null>;
  countPendingOutbox(): Promise<{ pending: number; oldestAgeMs: number }>;
}
export const ALERT_REPOSITORY = Symbol('AlertRepository');
