import { Notification, NotificationProvider } from '../notification-provider';
import { AlertDelivery } from '../alert-delivery';
import { FraudAlert } from '../../alerts/fraud-alert';
import { JsonLogger } from '../../observability/logger';

export const DELIVERY_TTL_MS = 10 * 60 * 1000;

/** Canal interno (equipe antifraude): recebe o alerta completo. Destino simulado; `fail` permite injetar falha em testes. */
export class AntifraudQueueProvider implements NotificationProvider {
  readonly channel = 'ANTIFRAUD_QUEUE' as const;
  readonly audience = 'ANTIFRAUD_TEAM' as const;
  readonly delivered: Notification[] = [];

  constructor(
    private readonly logger: JsonLogger,
    private readonly fail: () => boolean = () => false,
  ) {}

  buildDelivery(alert: FraudAlert, deliveryId: string, now: Date): AlertDelivery {
    return {
      schemaVersion: '1.0',
      deliveryId,
      alertId: alert.alertId,
      channel: this.channel,
      audience: this.audience,
      severity: alert.severity,
      customerId: alert.customerId,
      attempt: 1,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DELIVERY_TTL_MS).toISOString(),
      ...(alert.traceId ? { traceId: alert.traceId } : {}),
    };
  }

  async send(notification: Notification): Promise<void> {
    if (this.fail()) throw Object.assign(new Error('canal antifraude indisponível'), { code: 'ChannelUnavailable' });
    this.delivered.push(notification);
    this.logger.info('alerta entregue ao canal antifraude', {
      alertId: notification.alert.alertId,
      deliveryId: notification.delivery.deliveryId,
      traceId: notification.alert.traceId,
    });
  }
}
