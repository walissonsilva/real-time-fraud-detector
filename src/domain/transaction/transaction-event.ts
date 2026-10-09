import { Money } from '../shared/money';

export type TransactionEventType =
  | 'TRANSACTION_AUTHORIZED'
  | 'TRANSACTION_DECLINED'
  | 'TRANSACTION_REVERSED';

/** Espelha `TransactionEvent v1` (docs/contratos). Campos opcionais omitidos até serem necessários. */
export interface TransactionEvent {
  readonly schemaVersion: '1.0';
  readonly eventId: string;
  readonly transactionId: string;
  readonly eventType: TransactionEventType;
  readonly occurredAt: string;
  readonly producer: string;
  readonly transactionType: string;
  readonly channel: string;
  readonly amount: Money;
  readonly customerId: string;
  readonly accountId: string;
  readonly counterparty?: {
    readonly idToken?: string;
    readonly institutionCode?: string;
    readonly firstSeenAt?: string;
  };
  readonly merchant?: {
    readonly id?: string;
    readonly mcc?: string;
    readonly country?: string;
  };
  readonly declineReason?: string;
  readonly traceId?: string;
}

/** Mensagem recebida do broker, com os marcos de tempo de entrada (ingestedAt/consumedAt). */
export interface IngestedEvent {
  readonly event: TransactionEvent;
  readonly ingestedAt: Date;
  readonly consumedAt: Date;
  readonly traceparent?: string;
}
