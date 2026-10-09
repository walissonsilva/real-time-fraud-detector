/** Espelha `DlqMessage v1` (docs/contratos/dlq-message.v1.schema.json). */
export type DlqStage = 'INGEST_VALIDATION' | 'RULE_EVALUATION' | 'PERSISTENCE' | 'ALERT_PUBLISH' | 'CHANNEL_DELIVERY';

export type DlqReasonCode =
  | 'SCHEMA_INVALID'
  | 'DESERIALIZATION_ERROR'
  | 'UNSUPPORTED_VERSION'
  | 'RULE_EVALUATION_ERROR'
  | 'MAX_RETRIES_EXCEEDED'
  | 'PROVIDER_REJECTED'
  | 'DELIVERY_EXPIRED'
  | 'POISON_MESSAGE';

export interface DlqMessage {
  readonly schemaVersion: '1.0';
  readonly dlqId: string;
  readonly stage: DlqStage;
  readonly reasonCode: DlqReasonCode;
  /** Detalhe técnico sem PII e sem o payload (ex.: caminho do campo inválido). */
  readonly reasonDetail?: string;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly redriveCount: number;
  readonly correlation?: {
    readonly transactionId?: string;
    readonly alertId?: string;
    readonly deliveryId?: string;
    readonly channel?: string;
  };
  readonly traceId?: string;
  readonly original: {
    readonly source?: string;
    readonly partitionKey?: string;
    readonly contentType?: string;
    readonly encoding: 'json' | 'base64';
    readonly payload: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  };
}

export interface BuildDlqMessageInput {
  readonly stage: DlqStage;
  readonly reasonCode: DlqReasonCode;
  readonly reasonDetail?: string;
  readonly attempts?: number;
  readonly firstFailedAt?: Date;
  readonly source?: string;
  readonly partitionKey?: string;
  readonly rawBody: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly correlation?: DlqMessage['correlation'];
  readonly traceId?: string;
}

/** Preserva o corpo original: JSON válido vai como objeto, qualquer outra coisa como base64. */
export function buildDlqMessage(input: BuildDlqMessageInput, dlqId: string, now: Date = new Date()): DlqMessage {
  let encoding: 'json' | 'base64' = 'base64';
  let payload: unknown = Buffer.from(input.rawBody, 'utf8').toString('base64');
  try {
    const parsed: unknown = JSON.parse(input.rawBody);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      encoding = 'json';
      payload = parsed;
    }
  } catch {
    // mantém base64
  }
  return {
    schemaVersion: '1.0',
    dlqId,
    stage: input.stage,
    reasonCode: input.reasonCode,
    ...(input.reasonDetail ? { reasonDetail: input.reasonDetail.slice(0, 1024) } : {}),
    attempts: input.attempts ?? 1,
    firstFailedAt: (input.firstFailedAt ?? now).toISOString(),
    lastFailedAt: now.toISOString(),
    redriveCount: 0,
    ...(input.correlation ? { correlation: input.correlation } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    original: {
      ...(input.source ? { source: input.source } : {}),
      ...(input.partitionKey ? { partitionKey: input.partitionKey } : {}),
      contentType: 'application/json',
      encoding,
      payload,
      ...(input.headers ? { headers: input.headers } : {}),
    },
  };
}
