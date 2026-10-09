import { DeliveryChannel, DeliveryStatus } from '../../domain/alert/alert-delivery';

export interface DeliveryRepository {
  /** `INSERT … ON CONFLICT DO NOTHING`; devolve o status atual da entrega (nova = PENDING). */
  register(delivery: { deliveryId: string; alertId: string; channel: DeliveryChannel }): Promise<DeliveryStatus>;
  recordAttempt(deliveryId: string, errorCode: string): Promise<void>;
  markDelivered(deliveryId: string): Promise<void>;
  markDeadLettered(deliveryId: string, errorCode: string): Promise<void>;
  isDelivered(deliveryId: string): Promise<boolean>;
}
export const DELIVERY_REPOSITORY = Symbol('DeliveryRepository');
