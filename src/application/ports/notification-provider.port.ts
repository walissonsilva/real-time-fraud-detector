export interface Notification {
  readonly deliveryId: string;
  readonly alertId: string;
  readonly channel: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Canal de entrega (interno ou externo). O provedor externo é simulado no desafio. */
export interface NotificationProvider {
  readonly channel: string;
  send(notification: Notification): Promise<void>;
}
export const NOTIFICATION_PROVIDERS = Symbol('NotificationProviders');
