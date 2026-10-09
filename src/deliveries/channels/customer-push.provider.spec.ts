import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { FraudAlert } from '../../alerts/fraud-alert';
import { deliveryIdOf } from '../delivery-id';
import { AntifraudQueueProvider } from './antifraud-queue.provider';
import { CustomerPushProvider } from './customer-push.provider';
import { JsonLogger } from '../../observability/logger';

const contracts = join(__dirname, '../../../docs/contratos');
const alert = JSON.parse(readFileSync(join(contracts, 'examples/fraud-alert.valid.json'), 'utf8')) as FraudAlert;
const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(contracts, 'alert-delivery.v1.schema.json'), 'utf8')));

const logs: string[] = [];
const logger = {
  info: (m: string, f?: unknown) => logs.push(JSON.stringify([m, f])),
  warn: (m: string, f?: unknown) => logs.push(JSON.stringify([m, f])),
  error: (m: string, f?: unknown) => logs.push(JSON.stringify([m, f])),
} as unknown as JsonLogger;
const now = new Date('2026-10-03T14:21:07.620Z');

describe('CustomerPushProvider', () => {
  const provider = new CustomerPushProvider(logger);
  const delivery = provider.buildDelivery(alert, deliveryIdOf(alert.alertId, 'PUSH'), now);

  it('gera AlertDelivery v1 válido para o cliente', () => {
    expect(validate(delivery)).toBe(true);
    expect(delivery).toMatchObject({ channel: 'PUSH', audience: 'CUSTOMER', template: { id: 'suspicious-transaction.v1' } });
  });

  it('o payload ao cliente tem só tipo, valor formatado, data e orientação — nunca dados internos (FR-025)', async () => {
    await provider.send({ delivery, alert });
    expect(provider.sent).toHaveLength(1);
    expect(Object.keys(provider.sent[0]).sort()).toEqual(['amountFormatted', 'callToAction', 'transactionDate', 'transactionType']);
    expect(provider.sent[0]).toMatchObject({ transactionType: alert.transaction.transactionType, callToAction: 'CONFIRM_OR_DISPUTE' });
    expect(String(provider.sent[0].amountFormatted)).toMatch(/^R\$ [\d.]+,\d{2}$/);

    const outbound = JSON.stringify(provider.sent[0]);
    for (const rule of alert.triggeredRules) {
      expect(outbound).not.toContain(rule.ruleId);
      expect(outbound).not.toContain(rule.reason);
    }
    expect(outbound).not.toMatch(/score|severity|evidence|triggeredRules/i);
    expect(outbound).not.toContain(String(alert.score) + '"');
  });

  it('formata o valor em pt-BR', () => {
    const d = provider.buildDelivery({ ...alert, transaction: { ...alert.transaction, amount: { minorUnits: 1500000, currency: 'BRL' } } }, 'x'.repeat(64), now);
    expect(d.template?.params?.amountFormatted).toBe('R$ 15.000,00');
  });
});

describe('AntifraudQueueProvider', () => {
  it('gera AlertDelivery v1 válido para a equipe antifraude, sem template', () => {
    const d = new AntifraudQueueProvider(logger).buildDelivery(alert, deliveryIdOf(alert.alertId, 'ANTIFRAUD_QUEUE'), now);
    expect(validate(d)).toBe(true);
    expect(d).toMatchObject({ channel: 'ANTIFRAUD_QUEUE', audience: 'ANTIFRAUD_TEAM' });
    expect(d.template).toBeUndefined();
  });
});

describe('contrato AlertDelivery v1', () => {
  const dir = join(contracts, 'examples');
  for (const f of readdirSync(dir).filter((n) => n.startsWith('alert-delivery.'))) {
    const expected = f.endsWith('.valid.json');
    it(`${f} ${expected ? 'é aceito' : 'é rejeitado (ex.: canal interno com audiência cliente)'}`, () => {
      expect(validate(JSON.parse(readFileSync(join(dir, f), 'utf8')))).toBe(expected);
    });
  }

  it('logs dos provedores não carregam valor, regras nem identificador do cliente', async () => {
    const p = new CustomerPushProvider(logger);
    await p.send({ delivery: p.buildDelivery(alert, 'a'.repeat(64), now), alert });
    const all = logs.join('\n');
    expect(all).not.toContain(alert.customerId);
    expect(all).not.toContain('R$');
  });
});
