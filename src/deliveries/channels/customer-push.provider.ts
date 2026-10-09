import { Notification, NotificationProvider } from '../notification-provider';
import { AlertDelivery } from '../alert-delivery';
import { FraudAlert } from '../../alerts/fraud-alert';
import { DELIVERY_TTL_MS } from './antifraud-queue.provider';
import { JsonLogger } from '../../observability/logger';

export const CUSTOMER_TEMPLATE_ID = 'suspicious-transaction.v1';

type CustomerParams = Record<string, string | number | boolean>;

function formatMoney(minorUnits: number, currency: string): string {
  const major = (minorUnits / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'BRL' ? `R$ ${major}` : `${currency} ${major}`;
}

/**
 * Canal externo (cliente), provedor simulado. Só tipo, valor formatado e data da transação, mais a
 * orientação de confirmar/contestar; nunca regras, pontuação, severidade ou evidências (FR-025).
 */
export class CustomerPushProvider implements NotificationProvider {
  readonly channel = 'PUSH' as const;
  readonly audience = 'CUSTOMER' as const;
  /** Tudo que "saiu" para o cliente (simulação do provedor). */
  readonly sent: CustomerParams[] = [];

  constructor(
    private readonly logger: JsonLogger,
    private readonly fail: () => boolean = () => false,
  ) {}

  buildDelivery(alert: FraudAlert, deliveryId: string, now: Date): AlertDelivery {
    const params: CustomerParams = {
      transactionType: alert.transaction.transactionType,
      amountFormatted: formatMoney(alert.transaction.amount.minorUnits, alert.transaction.amount.currency),
      transactionDate: alert.transactionOccurredAt,
      callToAction: 'CONFIRM_OR_DISPUTE',
    };
    return {
      schemaVersion: '1.0',
      deliveryId,
      alertId: alert.alertId,
      channel: this.channel,
      audience: this.audience,
      severity: alert.severity,
      customerId: alert.customerId,
      template: { id: CUSTOMER_TEMPLATE_ID, locale: 'pt-BR', params },
      attempt: 1,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DELIVERY_TTL_MS).toISOString(),
      ...(alert.traceId ? { traceId: alert.traceId } : {}),
    };
  }

  async send({ delivery }: Notification): Promise<void> {
    if (this.fail()) throw Object.assign(new Error('provedor de push indisponível'), { code: 'ProviderUnavailable' });
    this.sent.push({ ...(delivery.template?.params ?? {}) });
    this.logger.info('notificação enviada ao cliente', { alertId: delivery.alertId, deliveryId: delivery.deliveryId, traceId: delivery.traceId });
  }
}
