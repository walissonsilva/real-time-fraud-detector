import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DLQ_PUBLISHER, DlqPublisher } from '../../application/ports/dlq-publisher.port';
import { EVENT_VALIDATOR, EventValidator, ValidationResult } from '../../application/ports/event-validator.port';
import { LOGGER, Logger, METRICS, Metrics } from '../../application/ports/observability.port';
import { ProcessTransaction, ProcessingError } from '../../application/use-cases/process-transaction';
import { RejectInvalidEvent } from '../../application/use-cases/reject-invalid-event';
import { buildDlqMessage, DlqStage } from '../../domain/dlq/dlq-message';
import { IngestedEvent } from '../../domain/transaction/transaction-event';
import { safeError } from '../observability/logger';
import { SQS_CLIENT } from '../aws/aws-clients.module';
import { APP_CONFIG, AppConfig } from '../config/config.module';

/** Retentativas aplicativas após a primeira tentativa (FR-003a). */
export const MAX_RETRIES = 3;
/** Long polling curto: o desligamento espera o poll em andamento terminar (e processa o que ele trouxe) em vez de abortá-lo, para não perder mensagens para uma conexão morta. */
const POLL_WAIT_S = 2;
const MAX_VISIBILITY_BACKOFF_S = 30;

@Injectable()
export class SqsTransactionConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private loops: Promise<void>[] = [];
  private queueUrl?: string;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EVENT_VALIDATOR) private readonly validator: EventValidator,
    private readonly processTransaction: ProcessTransaction,
    private readonly rejectInvalid: RejectInvalidEvent,
    @Inject(DLQ_PUBLISHER) private readonly dlq: DlqPublisher,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  /** Falha ao resolver a fila (ex.: configuração errada) derruba a inicialização em vez de rodar sem consumir. */
  async onApplicationBootstrap() {
    if (this.config.consumers.enabled) await this.start();
  }

  async onApplicationShutdown() {
    await this.stop();
  }

  async start(pollers = this.config.consumers.transactionPollers): Promise<void> {
    if (this.running) return;
    this.queueUrl = await this.resolveQueueUrl();
    this.running = true;
    this.loops = Array.from({ length: pollers }, () => this.pollLoop());
    this.logger.info('consumidor de transações iniciado', { queue: this.config.queues.transactions, pollers });
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private async resolveQueueUrl(): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.queues.transactions }));
    if (!QueueUrl) throw new Error(`fila não encontrada: ${this.config.queues.transactions}`);
    return QueueUrl;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: POLL_WAIT_S,
            MessageSystemAttributeNames: ['SentTimestamp', 'ApproximateReceiveCount'],
            MessageAttributeNames: ['traceparent'],
          }),
        );
        await Promise.all(Messages.map((m) => this.handle(m)));
      } catch (err) {
        if (!this.running) return;
        this.logger.error('falha no polling da fila de transações', safeError(err));
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Nunca lança: qualquer falha deixa a mensagem na fila para nova tentativa. */
  async handle(message: Message): Promise<void> {
    const rawBody = message.Body ?? '';
    try {
      const result = this.validator.validate(rawBody);
      if (!result.ok) {
        await this.handleInvalid(message, rawBody, result);
        return;
      }
      const traceparent = message.MessageAttributes?.traceparent?.StringValue;
      const sentTimestamp = Number(message.Attributes?.SentTimestamp);
      const ingested: IngestedEvent = {
        event: result.event,
        ingestedAt: Number.isFinite(sentTimestamp) && sentTimestamp > 0 ? new Date(sentTimestamp) : new Date(),
        consumedAt: new Date(),
        ...(traceparent ? { traceparent } : {}),
      };
      try {
        await this.processTransaction.execute(ingested);
      } catch (err) {
        await this.handleTransientFailure(message, rawBody, err, traceparent);
        return;
      }
      await this.delete(message);
    } catch (err) {
      this.logger.error('falha ao tratar mensagem; ela voltará à fila', safeError(err));
    }
  }

  /** Exclui o original só depois que o envio à DLQ foi confirmado; nunca chama ProcessTransaction (FR-008). */
  private async handleInvalid(message: Message, rawBody: string, result: Extract<ValidationResult, { ok: false }>) {
    await this.rejectInvalid.execute({
      rawBody,
      result,
      traceparent: message.MessageAttributes?.traceparent?.StringValue,
    });
    await this.delete(message);
  }

  private async handleTransientFailure(message: Message, rawBody: string, err: unknown, traceparent?: string) {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const stage: DlqStage = err instanceof ProcessingError ? err.stage : 'PERSISTENCE';
    this.metrics.increment('events_processed_total', { result: 'transient_failure' });

    if (receiveCount <= MAX_RETRIES) {
      const timeout = Math.min(MAX_VISIBILITY_BACKOFF_S, 2 ** receiveCount);
      this.logger.warn('falha transitória; retentativa agendada', { stage, attempt: receiveCount, retryInS: timeout, ...safeError(err) });
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: timeout }),
      );
      return;
    }

    let transactionId: string | undefined;
    try {
      transactionId = (JSON.parse(rawBody) as { transactionId?: string }).transactionId;
    } catch {
      /* corpo ilegível não chega aqui, mas não falhar por isso */
    }
    const dlqMessage = buildDlqMessage(
      {
        stage,
        reasonCode: 'MAX_RETRIES_EXCEEDED',
        reasonDetail: `tentativas esgotadas (${receiveCount}); erro=${safeError(err).errorName}`,
        attempts: receiveCount,
        source: this.config.queues.transactions,
        rawBody,
        ...(traceparent ? { headers: { traceparent } } : {}),
        ...(transactionId ? { correlation: { transactionId } } : {}),
      },
      randomUUID(),
    );
    await this.dlq.publish(this.config.queues.transactionsDlq, dlqMessage);
    this.metrics.increment('dlq_total', { stage });
    this.logger.error('tentativas esgotadas; evento enviado à DLQ', { stage, attempts: receiveCount, transactionId });
    await this.delete(message);
  }

  private async delete(message: Message) {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle! }));
  }
}
