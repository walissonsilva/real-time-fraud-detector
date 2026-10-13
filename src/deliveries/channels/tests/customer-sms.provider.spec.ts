import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CustomerSmsProvider } from '../customer-sms.provider';
import { FraudAlert } from '../../../alerts/types/fraud-alert';
import { JsonLogger } from '../../../observability/logger';

const alert = JSON.parse(readFileSync(join(__dirname, '../../../../docs/contratos/examples/fraud-alert.valid.json'), 'utf8')) as FraudAlert;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as JsonLogger;

describe('CustomerSmsProvider', () => {
  it('monta um AlertDelivery SMS para o cliente com o mesmo conteúdo mínimo do push', () => {
    const delivery = new CustomerSmsProvider(logger).buildDelivery(alert, 'd'.repeat(64), new Date('2026-10-12T12:00:00Z'));
    expect(delivery).toMatchObject({ channel: 'SMS', audience: 'CUSTOMER', customerId: alert.customerId, template: { id: 'suspicious-transaction.v1' } });
    expect(JSON.stringify(delivery.template?.params)).not.toMatch(/score|severity|high-amount/i);
  });

  it('falha quando o provedor está indisponível', async () => {
    const sms = new CustomerSmsProvider(logger, () => true);
    const delivery = sms.buildDelivery(alert, 'd'.repeat(64), new Date());
    await expect(sms.send({ delivery, alert })).rejects.toMatchObject({ code: 'ProviderUnavailable' });
    expect(sms.sent).toHaveLength(0);
  });
});
