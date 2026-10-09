import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonLogger, redact, safeError } from './logger';

describe('JsonLogger (SC-007)', () => {
  it('não vaza IP, geolocalização, ids em claro nem o conteúdo do evento', () => {
    const event = JSON.parse(
      readFileSync(join(__dirname, '../../../docs/contratos/examples/transaction-event.authorized.valid.json'), 'utf8'),
    );
    event.origin.ipAddress = '203.0.113.7';
    const lines: string[] = [];
    const logger = new JsonLogger((l) => lines.push(l));

    logger.info('evento recebido', { transactionId: 'tx-1', event, origin: event.origin, customerId: event.customerId });

    const out = lines.join('\n');
    expect(out).not.toContain('203.0.113.7');
    expect(out).not.toContain('-23.55');
    expect(out).not.toContain(event.customerId);
    expect(out).not.toContain(event.accountId);
    expect(out).toContain('tx-1');
  });

  it('redige chaves sensíveis em qualquer nível, sem alterar as demais', () => {
    expect(redact({ a: { geo: { latitude: 1 }, ok: 1 }, list: [{ ipAddress: 'x' }] })).toEqual({
      a: { geo: '[REDACTED]', ok: 1 },
      list: [{ ipAddress: '[REDACTED]' }],
    });
  });

  it('safeError descarta a mensagem', () => {
    expect(safeError(Object.assign(new Error('ip 203.0.113.7'), { code: 'EFAIL' }))).toEqual({
      errorName: 'Error',
      errorCode: 'EFAIL',
    });
  });
});
