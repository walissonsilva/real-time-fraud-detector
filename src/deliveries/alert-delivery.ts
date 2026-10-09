import { Severity } from '../rules/rule';

export type DeliveryChannel = 'ANTIFRAUD_QUEUE' | 'ANTIFRAUD_WEBHOOK' | 'PUSH' | 'SMS' | 'EMAIL';
export type DeliveryAudience = 'ANTIFRAUD_TEAM' | 'CUSTOMER';
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'DEAD_LETTERED';

/** Espelha `AlertDelivery v1` (docs/contratos/alert-delivery.v1.schema.json). */
export interface AlertDelivery {
  readonly schemaVersion: '1.0';
  readonly deliveryId: string;
  readonly alertId: string;
  readonly channel: DeliveryChannel;
  readonly audience: DeliveryAudience;
  readonly severity: Severity;
  readonly customerId: string;
  readonly template?: {
    readonly id: string;
    readonly locale?: string;
    readonly params?: Readonly<Record<string, string | number | boolean>>;
  };
  readonly attempt: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly traceId?: string;
}
