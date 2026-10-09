import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DeliveryChannel, DeliveryStatus } from './alert-delivery';
import { PG_POOL } from '../database/pg-pool.token';

@Injectable()
export class DeliveryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** `INSERT … ON CONFLICT DO NOTHING`; devolve o status atual da entrega (nova = PENDING). */
  async register(d: { deliveryId: string; alertId: string; channel: DeliveryChannel }): Promise<DeliveryStatus> {
    await this.pool.query(
      `INSERT INTO deliveries (delivery_id, alert_id, channel, status) VALUES ($1,$2,$3,'PENDING')
       ON CONFLICT (delivery_id) DO NOTHING`,
      [d.deliveryId, d.alertId, d.channel],
    );
    const { rows } = await this.pool.query<{ status: DeliveryStatus }>('SELECT status FROM deliveries WHERE delivery_id = $1', [d.deliveryId]);
    return rows[0].status;
  }

  async recordAttempt(deliveryId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      'UPDATE deliveries SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE delivery_id = $1',
      [deliveryId, errorCode],
    );
  }

  async markDelivered(deliveryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE deliveries SET status = 'DELIVERED', attempts = attempts + 1, last_error = NULL, updated_at = now()
        WHERE delivery_id = $1 AND status <> 'DELIVERED'`,
      [deliveryId],
    );
  }

  async markDeadLettered(deliveryId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE deliveries SET status = 'DEAD_LETTERED', last_error = $2, updated_at = now()
        WHERE delivery_id = $1 AND status = 'PENDING'`,
      [deliveryId, errorCode],
    );
  }

  async isDelivered(deliveryId: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT 1 FROM deliveries WHERE delivery_id = $1 AND status = $2', [deliveryId, 'DELIVERED']);
    return rows.length > 0;
  }
}
