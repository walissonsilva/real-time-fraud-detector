import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from '../aws/aws-clients.module';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { SqsDlqPublisher } from '../dlq/sqs-dlq.publisher';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { DeliverAlertService } from './deliver-alert.service';
import { NOTIFICATION_PROVIDERS, NotificationProvider } from './notification-provider';
import { SqsChannelConsumer } from './sqs-channel.consumer';

/** Sobe um consumidor independente por canal (FR-021). */
@Injectable()
export class ChannelConsumers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumers: SqsChannelConsumer[];

  constructor(
    @Inject(SQS_CLIENT) sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NOTIFICATION_PROVIDERS) providers: NotificationProvider[],
    deliver: DeliverAlertService,
    dlq: SqsDlqPublisher,
    logger: JsonLogger,
    metrics: InMemoryMetrics,
  ) {
    const queues: Record<string, { queue: string; dlqQueue: string }> = {
      ANTIFRAUD_QUEUE: { queue: config.queues.antifraudChannel, dlqQueue: config.queues.antifraudChannelDlq },
      PUSH: { queue: config.queues.customerChannel, dlqQueue: config.queues.customerChannelDlq },
    };
    this.consumers = providers.map(
      (p) =>
        new SqsChannelConsumer(sqs, p, deliver, dlq, logger, metrics, { ...queues[p.channel], pollers: config.consumers.channelPollers }),
    );
  }

  async onApplicationBootstrap() {
    if (this.config.consumers.enabled && this.config.consumers.channelsEnabled) await Promise.all(this.consumers.map((c) => c.start()));
  }

  async onApplicationShutdown() {
    await Promise.all(this.consumers.map((c) => c.stop()));
  }
}
