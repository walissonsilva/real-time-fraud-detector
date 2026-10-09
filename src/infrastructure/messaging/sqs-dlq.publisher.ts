import { Inject, Injectable } from '@nestjs/common';
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DlqPublisher } from '../../application/ports/dlq-publisher.port';
import { DlqMessage } from '../../domain/dlq/dlq-message';
import { SQS_CLIENT } from '../aws/aws-clients.module';

@Injectable()
export class SqsDlqPublisher implements DlqPublisher {
  private readonly urls = new Map<string, string>();

  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  async publish(queue: string, message: DlqMessage): Promise<void> {
    const QueueUrl = await this.urlOf(queue);
    const fifo = queue.endsWith('.fifo');
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          'schema-version': { DataType: 'String', StringValue: message.schemaVersion },
          'reason-code': { DataType: 'String', StringValue: message.reasonCode },
        },
        ...(fifo
          ? { MessageGroupId: message.correlation?.channel ?? message.stage, MessageDeduplicationId: message.dlqId }
          : {}),
      }),
    );
  }

  private async urlOf(queue: string): Promise<string> {
    const cached = this.urls.get(queue);
    if (cached) return cached;
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queue }));
    if (!QueueUrl) throw new Error(`fila não encontrada: ${queue}`);
    this.urls.set(queue, QueueUrl);
    return QueueUrl;
  }
}
