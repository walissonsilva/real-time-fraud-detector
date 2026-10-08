import { FraudAlert } from '../../domain/alert/fraud-alert';

/**
 * Persistência transacional do alerta + outbox (ADR-04).
 * Retorna `false` quando `dedupeKey` já existia (duplicata: nada é gravado).
 */
export interface AlertRepository {
  saveWithOutbox(alert: FraudAlert): Promise<boolean>;
  markPublished(alertId: string, publishedAt: Date): Promise<void>;
  /** Para o relay: pendentes há mais de `olderThanMs`, com `FOR UPDATE SKIP LOCKED`. */
  claimPendingOutbox(limit: number, olderThanMs: number): Promise<FraudAlert[]>;
}
export const ALERT_REPOSITORY = Symbol('AlertRepository');
