import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { TransactionEvent } from './transaction-event';

const SCHEMA_PATH = join(__dirname, '../../docs/contratos/transaction-event.v1.schema.json');
const SUPPORTED_MAJOR = 1;

export type RejectionReason = 'DESERIALIZATION_ERROR' | 'SCHEMA_INVALID' | 'UNSUPPORTED_VERSION';

export type ValidationResult =
  | { readonly ok: true; readonly event: TransactionEvent }
  | {
      readonly ok: false;
      readonly reasonCode: RejectionReason;
      /** Caminho do campo + palavra-chave violada. Nunca contém valores do evento (FR-009). */
      readonly detail: string;
    };

function describeError(err: ErrorObject): string {
  let path = err.instancePath || '';
  if (err.keyword === 'additionalProperties') path += `/${String(err.params.additionalProperty)}`;
  if (err.keyword === 'required') path += `/${String(err.params.missingProperty)}`;
  return `${path || '/'}: ${err.keyword}`;
}

/** Valida contra `TransactionEvent v1` (FR-004..FR-006). A mensagem de erro só descreve caminho e regra, nunca valores. */
export class AjvTransactionEventValidator {
  private readonly validateFn: ValidateFunction;

  constructor(schemaPath: string = SCHEMA_PATH) {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: false });
    addFormats(ajv);
    this.validateFn = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  }

  validate(rawBody: string): ValidationResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { ok: false, reasonCode: 'DESERIALIZATION_ERROR', detail: 'corpo não é JSON válido' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reasonCode: 'SCHEMA_INVALID', detail: '/: type' };
    }
    const version = (parsed as Record<string, unknown>).schemaVersion;
    if (typeof version === 'string') {
      const match = /^(\d+)\.\d+$/.exec(version);
      if (match && Number(match[1]) !== SUPPORTED_MAJOR) {
        return { ok: false, reasonCode: 'UNSUPPORTED_VERSION', detail: '/schemaVersion: major não suportada' };
      }
    }
    if (!this.validateFn(parsed)) {
      const [first] = this.validateFn.errors ?? [];
      return { ok: false, reasonCode: 'SCHEMA_INVALID', detail: first ? describeError(first) : '/: invalid' };
    }
    return { ok: true, event: parsed as unknown as TransactionEvent };
  }
}
