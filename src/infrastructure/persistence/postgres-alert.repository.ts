import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { FraudAlert } from '../../domain/alert/fraud-alert';
import { AlertRepository } from '../../application/ports/alert-repository.port';
import { PG_POOL } from './pg-pool.token';

@Injectable()
export class PostgresAlertRepository implements AlertRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async saveWithOutbox(alert: FraudAlert): Promise<boolean> {
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
          JSON.stringify({ amount: alert.amount }), alert.degraded, alert.late, alert.status,
          alert.ingestedAt, alert.detectedAt,
        ],
      );
      if (inserted.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('INSERT INTO outbox (alert_id, payload) VALUES ($1, $2)', [
        alert.alertId,
        JSON.stringify(alert),
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

  async markPublished(alertId: string, publishedAt: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE outbox SET published_at = $2 WHERE alert_id = $1', [alertId, publishedAt]);
      await client.query('UPDATE alerts SET published_at = $2 WHERE alert_id = $1', [alertId, publishedAt]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async claimPendingOutbox(limit: number, olderThanMs: number): Promise<FraudAlert[]> {
    const { rows } = await this.pool.query<{ payload: FraudAlert }>(
      `SELECT payload FROM outbox
        WHERE published_at IS NULL AND created_at < now() - ($2 * interval '1 millisecond')
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit, olderThanMs],
    );
    return rows.map((r) => r.payload);
  }
}
