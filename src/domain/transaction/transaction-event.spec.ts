import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TransactionEvent } from './transaction-event';

describe('TransactionEvent', () => {
  it('o exemplo do contrato é compatível com o tipo de domínio', () => {
    const raw = readFileSync(
      join(__dirname, '../../../docs/contratos/examples/transaction-event.authorized.valid.json'),
      'utf8',
    );
    const event: TransactionEvent = JSON.parse(raw);
    expect(event.amount.minorUnits).toBeGreaterThan(0);
  });
});
