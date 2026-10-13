import { Notification, NotificationProvider } from '../notification-provider';
import { AlertDelivery } from '../alert-delivery';
import { FraudAlert } from '../../alerts/fraud-alert';
import { DELIVERY_TTL_MS } from './antifraud-queue.provider';
import { CUSTOMER_TEMPLATE_ID, CustomerParams, customerParams } from './customer-push.provider';
import { JsonLogger } from '../../observability/logger';

export class CustomerSmsProvider implements NotificationProvider {
  readonly channel = 'SMS' as const;
  readonly audience = 'CUSTOMER' as const;
  readonly sent: CustomerParams[] = [];

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
      template: { id: CUSTOMER_TEMPLATE_ID, locale: 'pt-BR', params: customerParams(alert) },
      attempt: 1,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DELIVERY_TTL_MS).toISOString(),
      ...(alert.traceId ? { traceId: alert.traceId } : {}),
    };
  }

  async send({ delivery }: Notification): Promise<void> {
    if (this.fail()) throw Object.assign(new Error('provedor de SMS indisponível'), { code: 'ProviderUnavailable' });
    this.sent.push({ ...(delivery.template?.params ?? {}) });
    this.logger.info('SMS enviado ao cliente', { alertId: delivery.alertId, deliveryId: delivery.deliveryId, traceId: delivery.traceId });
  }
}
