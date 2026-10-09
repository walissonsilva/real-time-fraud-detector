import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { DlqPublisher } from '../../application/ports/dlq-publisher.port';
import { NotificationProvider } from '../../application/ports/notification-provider.port';
import { Logger, Metrics } from '../../application/ports/observability.port';
import { DeliverAlert } from '../../application/use-cases/deliver-alert';
import { FraudAlert } from '../../domain/alert/fraud-alert';
import { buildDlqMessage } from '../../domain/dlq/dlq-message';
import { safeError } from '../observability/logger';

const POLL_WAIT_S = 2;

export interface SqsChannelConsumerOptions {
  readonly queue: string;
  readonly dlqQueue: string;
  readonly pollers: number;
}

function parseAlert(body: string): FraudAlert | undefined {
  try {
    const a = JSON.parse(body) as Partial<FraudAlert> | null;
    if (a && typeof a === 'object' && typeof a.alertId === 'string' && typeof a.customerId === 'string' && a.transaction && a.severity) {
      return a as FraudAlert;
    }
  } catch {
    /* mensagem ilegível: tratada como veneno */
  }
  return undefined;
}

/**
 * Consumidor de UM canal: lê a fila FIFO do canal (corpo = FraudAlert v1, RawMessageDelivery) e invoca o
 * `DeliverAlert` do provedor. A mensagem só é excluída após `DELIVERED` ou `DEAD_LETTERED` durável (FR-023);
 * falhas de infraestrutura a deixam na fila. Cada canal tem seus próprios loops, então um canal lento ou
 * fora não bloqueia o outro (FR-021).
 */
export class SqsChannelConsumer {
  private running = false;
  private loops: Promise<void>[] = [];
  private queueUrl?: string;

  constructor(
    private readonly sqs: SQSClient,
    private readonly provider: NotificationProvider,
    private readonly deliver: DeliverAlert,
    private readonly dlq: DlqPublisher,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    private readonly options: SqsChannelConsumerOptions,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.options.queue }));
    if (!QueueUrl) throw new Error(`fila não encontrada: ${this.options.queue}`);
    this.queueUrl = QueueUrl;
    this.running = true;
    this.loops = Array.from({ length: this.options.pollers }, () => this.pollLoop());
    this.logger.info('consumidor de canal iniciado', { channel: this.provider.channel, queue: this.options.queue });
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: POLL_WAIT_S,
            MessageSystemAttributeNames: ['MessageGroupId'],
          }),
        );
        // Mensagens do mesmo grupo (conta) preservam a ordem; grupos distintos em paralelo.
        const byGroup = new Map<string, Message[]>();
        for (const m of Messages) {
          const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? randomUUID();
          byGroup.set(g, [...(byGroup.get(g) ?? []), m]);
        }
        await Promise.all([...byGroup.values()].map(async (group) => {
          for (const m of group) await this.handle(m);
        }));
      } catch (err) {
        if (!this.running) return;
        this.logger.error('falha no polling da fila do canal', { channel: this.provider.channel, ...safeError(err) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Nunca lança: qualquer falha deixa a mensagem na fila para reentrega. */
  async handle(message: Message): Promise<void> {
    const body = message.Body ?? '';
    try {
      const alert = parseAlert(body);
      if (!alert) {
        await this.rejectPoison(body);
        await this.delete(message);
        return;
      }
      await this.deliver.execute(alert, this.provider);
      await this.delete(message);
    } catch (err) {
      this.metrics.increment('deliveries_total', { channel: this.provider.channel, status: 'infra_failure' });
      this.logger.error('falha ao tratar entrega; mensagem voltará à fila', { channel: this.provider.channel, ...safeError(err) });
    }
  }

  private async rejectPoison(body: string) {
    await this.dlq.publish(
      this.options.dlqQueue,
      buildDlqMessage(
        {
          stage: 'CHANNEL_DELIVERY',
          reasonCode: 'POISON_MESSAGE',
          reasonDetail: 'mensagem do canal ilegível ou sem os campos mínimos do FraudAlert',
          source: this.options.queue,
          rawBody: body,
          correlation: { channel: this.provider.channel },
        },
        randomUUID(),
      ),
    );
    this.metrics.increment('dlq_total', { stage: 'CHANNEL_DELIVERY' });
    this.logger.error('mensagem de canal inválida enviada à DLQ', { channel: this.provider.channel });
  }

  private async delete(message: Message) {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle! }));
  }
}
