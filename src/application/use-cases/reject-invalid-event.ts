import { randomUUID } from 'node:crypto';
import { DlqPublisher } from '../ports/dlq-publisher.port';
import { ValidationResult } from '../ports/event-validator.port';
import { Logger, Metrics } from '../ports/observability.port';
import { buildDlqMessage } from '../../domain/dlq/dlq-message';

export interface RejectInvalidEventDeps {
  readonly dlq: DlqPublisher;
  readonly dlqQueue: string;
  /** Nome lógico da fila de origem, preservado na DlqMessage. */
  readonly source: string;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly newId?: () => string;
}

export interface RejectInvalidEventInput {
  readonly rawBody: string;
  readonly result: Extract<ValidationResult, { ok: false }>;
  readonly traceparent?: string;
}

/**
 * Evento inválido → DLQ com motivo e original preservado (FR-007/FR-008). Log e métricas só carregam
 * código do motivo e caminho do campo, nunca o conteúdo (FR-009). Se o envio à DLQ falhar, lança:
 * o chamador não pode excluir a mensagem de entrada.
 */
export class RejectInvalidEvent {
  private readonly newId: () => string;

  constructor(private readonly deps: RejectInvalidEventDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  async execute({ rawBody, result, traceparent }: RejectInvalidEventInput): Promise<void> {
    const { dlq, dlqQueue, source, logger, metrics } = this.deps;
    const transactionId = extractTransactionId(rawBody);
    const message = buildDlqMessage(
      {
        stage: 'INGEST_VALIDATION',
        reasonCode: result.reasonCode,
        reasonDetail: result.detail,
        attempts: 1,
        source,
        rawBody,
        ...(traceparent ? { headers: { traceparent } } : {}),
        ...(transactionId ? { correlation: { transactionId } } : {}),
      },
      this.newId(),
    );
    await dlq.publish(dlqQueue, message);
    metrics.increment('events_rejected_total', { reason: result.reasonCode });
    metrics.increment('dlq_total', { stage: 'INGEST_VALIDATION' });
    logger.warn('evento inválido rejeitado e enviado à DLQ', {
      reasonCode: result.reasonCode,
      detail: result.detail,
      dlqId: message.dlqId,
    });
  }
}

function extractTransactionId(rawBody: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const id = (parsed as { transactionId?: unknown } | null)?.transactionId;
    return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined;
  } catch {
    return undefined;
  }
}
