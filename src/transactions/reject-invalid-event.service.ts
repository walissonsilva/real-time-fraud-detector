import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { randomUUID } from 'node:crypto';
import { buildDlqMessage } from '../dlq/dlq-message';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { SqsDlqPublisher } from '../dlq/sqs-dlq.publisher';
import { ValidationResult } from './ajv-transaction-event.validator';

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
@Injectable()
export class RejectInvalidEventService {
  /** Gerador de id substituível em testes. */
  newId: () => string = randomUUID;

  constructor(
    private readonly dlq: SqsDlqPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: JsonLogger,
    private readonly metrics: InMemoryMetrics,
  ) {}

  async execute({ rawBody, result, traceparent }: RejectInvalidEventInput): Promise<void> {
    const { dlq, logger, metrics } = this;
    const dlqQueue = this.config.queues.transactionsDlq;
    const source = this.config.queues.transactions;
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
