import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvTransactionEventValidator } from './ajv-transaction-event.validator';

const examples = join(__dirname, '../../../docs/contratos/examples');
const load = (file: string) => readFileSync(join(examples, file), 'utf8');

describe('AjvTransactionEventValidator', () => {
  const validator = new AjvTransactionEventValidator();
  const files = readdirSync(examples).filter((f) => f.startsWith('transaction-event.'));

  it.each(files.filter((f) => f.endsWith('.valid.json')))('aceita %s', (file) => {
    expect(validator.validate(load(file)).ok).toBe(true);
  });

  it.each(files.filter((f) => f.endsWith('.invalid.json')))('rejeita %s como SCHEMA_INVALID', (file) => {
    const result = validator.validate(load(file));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('SCHEMA_INVALID');
  });

  it('informa o campo ausente sem ecoar valores', () => {
    const result = validator.validate(load('transaction-event.missing-accountId.invalid.json'));
    expect(result).toEqual({ ok: false, reasonCode: 'SCHEMA_INVALID', detail: '/accountId: required' });
  });

  it('não vaza o valor do campo proibido com dado pessoal', () => {
    const body = load('transaction-event.pii-field.invalid.json');
    const result = validator.validate(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const values = Object.values(JSON.parse(body)).filter((v) => typeof v === 'string') as string[];
      for (const v of values) expect(result.detail).not.toContain(v);
    }
  });

  it('JSON truncado → DESERIALIZATION_ERROR', () => {
    const body = load('transaction-event.authorized.valid.json');
    expect(validator.validate(body.slice(0, 40))).toMatchObject({ ok: false, reasonCode: 'DESERIALIZATION_ERROR' });
  });

  it('versão major desconhecida → UNSUPPORTED_VERSION', () => {
    const body = JSON.stringify({ ...JSON.parse(load('transaction-event.authorized.valid.json')), schemaVersion: '2.0' });
    expect(validator.validate(body)).toMatchObject({ ok: false, reasonCode: 'UNSUPPORTED_VERSION' });
  });

  it('aceita versão secundária compatível 1.x', () => {
    const body = JSON.stringify({ ...JSON.parse(load('transaction-event.authorized.valid.json')), schemaVersion: '1.7' });
    expect(validator.validate(body).ok).toBe(true);
  });

  it('JSON que não é objeto → SCHEMA_INVALID', () => {
    expect(validator.validate('[1,2]')).toMatchObject({ ok: false, reasonCode: 'SCHEMA_INVALID' });
  });
});
