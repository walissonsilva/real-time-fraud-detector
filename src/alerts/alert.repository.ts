import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { FraudAlert } from './fraud-alert';
import { PG_POOL } from '../database/pg-pool.token';

/** Linha pendente do outbox: o alerta a publicar e o contexto de rastreamento. */
export interface OutboxEntry {
  readonly alert: FraudAlert;
  readonly traceparent?: string;
  readonly attempts: number;
}

interface OutboxRow {
  payload: FraudAlert;
  traceparent: string | null;
  attempts: number;
}

const toEntry = (row: OutboxRow): OutboxEntry => ({
  alert: row.payload,
  attempts: row.attempts,
  ...(row.traceparent ? { traceparent: row.traceparent } : {}),
});

/**
 * Persistência transacional do alerta + outbox (ADR-04).
 * `saveWithOutbox` retorna `false` quando `dedupeKey` já existia (duplicata: nada é gravado).
 */
@Injectable()
export class AlertRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async saveWithOutbox(alert: FraudAlert, traceparent?: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO alerts (alert_id, dedupe_key, transaction_id, customer_id, account_id, severity, score,
                             rules, summary, degraded, late, status, ingested_at, detected_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          alert.alertId, alert.dedupeKey, alert.transactionId, alert.customerId, alert.accountId,
          alert.severity, alert.score, JSON.stringify(alert.triggeredRules),
          JSON.stringify(alert.transaction), alert.degraded, alert.late, alert.status,
          alert.ingestedAt, alert.detectedAt,
        ],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('INSERT INTO outbox (alert_id, payload, traceparent) VALUES ($1, $2, $3)', [
        alert.alertId,
        JSON.stringify(alert),
        traceparent ?? null,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Idempotente: preserva o primeiro instante de publicação. */
  async markPublished(alertId: string, publishedAt: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE outbox SET published_at = $2 WHERE alert_id = $1 AND published_at IS NULL', [alertId, publishedAt]);
      await client.query('UPDATE alerts SET published_at = $2 WHERE alert_id = $1 AND published_at IS NULL', [alertId, publishedAt]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Registra falha de publicação (sem PII) e agenda a próxima tentativa com backoff. */
  async recordPublishFailure(alertId: string, errorCode: string): Promise<void> {
    // Backoff exponencial do relay: 1 s, 2 s, 4 s ... limitado a 60 s.
    await this.pool.query(
      `UPDATE outbox
          SET attempts = attempts + 1,
              last_error = $2,
              next_attempt_at = now() + LEAST(60000, 1000 * power(2, attempts)) * interval '1 millisecond'
        WHERE alert_id = $1 AND published_at IS NULL`,
      [alertId, errorCode.slice(0, 64)],
    );
  }

  /**
   * Para o relay: reivindica pendentes criados há mais de `olderThanMs` e cuja próxima tentativa já venceu.
   * Usa `FOR UPDATE SKIP LOCKED` e um lease (`next_attempt_at`) para que instâncias concorrentes não
   * processem a mesma linha.
   */
  async claimPendingOutbox(limit: number, olderThanMs: number, leaseMs = 30_000): Promise<OutboxEntry[]> {
    const { rows } = await this.pool.query<OutboxRow>(
      `UPDATE outbox o
          SET next_attempt_at = now() + ($3 * interval '1 millisecond')
        WHERE o.alert_id IN (
          SELECT alert_id FROM outbox
           WHERE published_at IS NULL
             AND next_attempt_at <= now()
             AND created_at < now() - ($2 * interval '1 millisecond')
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
      RETURNING o.payload, o.traceparent, o.attempts`,
      [limit, olderThanMs, leaseMs],
    );
    return rows.map(toEntry);
  }

  /** Para reentrega do evento de entrada (FR-017a): a linha do outbox do alerta existente, se ainda pendente. */
  async findPendingByDedupeKey(dedupeKey: string): Promise<OutboxEntry | null> {
    const { rows } = await this.pool.query<OutboxRow>(
      `SELECT o.payload, o.traceparent, o.attempts
         FROM alerts a JOIN outbox o USING (alert_id)
        WHERE a.dedupe_key = $1 AND o.published_at IS NULL`,
      [dedupeKey],
    );
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async countPendingOutbox(): Promise<{ pending: number; oldestAgeMs: number }> {
    const { rows } = await this.pool.query<{ pending: string; oldest_ms: string | null }>(
      `SELECT count(*) AS pending,
              (EXTRACT(EPOCH FROM (now() - min(created_at))) * 1000)::bigint AS oldest_ms
         FROM outbox WHERE published_at IS NULL`,
    );
    return { pending: Number(rows[0].pending), oldestAgeMs: Number(rows[0].oldest_ms ?? 0) };
  }
}
