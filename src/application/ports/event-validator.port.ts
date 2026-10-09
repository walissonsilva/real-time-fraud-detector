import { TransactionEvent } from '../../domain/transaction/transaction-event';

export type RejectionReason = 'DESERIALIZATION_ERROR' | 'SCHEMA_INVALID' | 'UNSUPPORTED_VERSION';

export type ValidationResult =
  | { readonly ok: true; readonly event: TransactionEvent }
  | {
      readonly ok: false;
      readonly reasonCode: RejectionReason;
      /** Caminho do campo + palavra-chave violada. Nunca contém valores do evento (FR-009). */
      readonly detail: string;
    };

export interface EventValidator {
  validate(rawBody: string): ValidationResult;
}
export const EVENT_VALIDATOR = Symbol('EventValidator');
