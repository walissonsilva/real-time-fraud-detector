import { createHash } from 'node:crypto';
import { DeliveryChannel } from './alert-delivery';

/** sha256("alert-delivery:v1:" + alertId + ":" + canal): estável entre retentativas (FR-024). */
export function deliveryIdOf(alertId: string, channel: DeliveryChannel): string {
  return createHash('sha256').update(`alert-delivery:v1:${alertId}:${channel}`).digest('hex');
}
