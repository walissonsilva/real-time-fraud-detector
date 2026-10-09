import { Inject, Injectable } from '@nestjs/common';
import { CreateTopicCommand, PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { EventBus } from '../../application/ports/event-bus.port';
import { retry } from '../../application/shared/retry';
import { PublishableFraudAlert, FraudAlert } from '../../domain/alert/fraud-alert';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { SNS_CLIENT } from '../aws/aws-clients.module';

/**
 * Publica o `FraudAlert v1` em `alerts.fifo` (contracts/messaging.md).
 * Grupo = accountId (ordem por conta); dedupe = dedupeKey (janela de 5 min do SNS FIFO).
 */
@Injectable()
export class SnsEventBus implements EventBus {
  private topicArn?: string;

  constructor(
    @Inject(SNS_CLIENT) private readonly sns: SNSClient,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'snsAlertsTopic' | 'snsPublishTimeoutMs'>,
  ) {}

  async publishAlert(alert: FraudAlert, traceparent?: string): Promise<void> {
    if (!alert.publishedAt) throw new Error('alerta sem publishedAt: carimbar antes de publicar');
    const published = alert as PublishableFraudAlert;
    const TopicArn = await this.resolveTopicArn();
    await retry(
      () =>
        this.sns.send(
          new PublishCommand({
            TopicArn,
            Message: JSON.stringify(published),
            MessageGroupId: published.accountId,
            MessageDeduplicationId: published.dedupeKey,
            MessageAttributes: {
              'schema-version': { DataType: 'String', StringValue: published.schemaVersion },
              'message-id': { DataType: 'String', StringValue: published.alertId },
              ...(traceparent ? { traceparent: { DataType: 'String', StringValue: traceparent } } : {}),
            },
          }),
        ),
      { attempts: 3, baseDelayMs: 50, maxDelayMs: 400, timeoutMs: this.config.snsPublishTimeoutMs },
    );
  }

  /** `CreateTopic` é idempotente e devolve o ARN do tópico FIFO existente (criado pelo init-aws.sh). */
  private async resolveTopicArn(): Promise<string> {
    if (this.topicArn) return this.topicArn;
    const { TopicArn } = await this.sns.send(
      new CreateTopicCommand({
        Name: this.config.snsAlertsTopic,
        Attributes: { FifoTopic: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    if (!TopicArn) throw new Error('tópico SNS não resolvido');
    this.topicArn = TopicArn;
    return TopicArn;
  }
}
