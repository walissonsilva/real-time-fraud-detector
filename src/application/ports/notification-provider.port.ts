import { AlertDelivery, DeliveryAudience, DeliveryChannel } from '../../domain/alert/alert-delivery';
import { FraudAlert } from '../../domain/alert/fraud-alert';

/** Pedido de entrega + alerta de origem. Cada provedor decide o que do alerta pode sair pelo canal (FR-025). */
export interface Notification {
  readonly delivery: AlertDelivery;
  readonly alert: FraudAlert;
}

/** Canal de entrega (interno ou externo). O provedor externo é simulado no desafio. */
export interface NotificationProvider {
  readonly channel: DeliveryChannel;
  readonly audience: DeliveryAudience;
  /** Monta o `AlertDelivery v1` deste canal a partir do alerta (idempotente: `deliveryId` é estável). */
  buildDelivery(alert: FraudAlert, deliveryId: string, now: Date): AlertDelivery;
  /** Rejeita em falha; o chamador aplica timeout, retentativa e DLQ. */
  send(notification: Notification): Promise<void>;
}
export const NOTIFICATION_PROVIDERS = Symbol('NotificationProviders');
