import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, AppConfig } from '../config/config.module';

export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const SNS_CLIENT = Symbol('SNS_CLIENT');

@Injectable()
class AwsClientsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SNS_CLIENT) private readonly sns: SNSClient,
  ) {}
  onApplicationShutdown() {
    this.sqs.destroy();
    this.sns.destroy();
  }
}

/** Endpoint customizado só no ambiente local (LocalStack); em produção o SDK usa HTTPS por padrão (FR-026). */
@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new SQSClient({ region: c.aws.region, endpoint: c.aws.endpoint }),
    },
    {
      provide: SNS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new SNSClient({ region: c.aws.region, endpoint: c.aws.endpoint }),
    },
    AwsClientsLifecycle,
  ],
  exports: [SQS_CLIENT, SNS_CLIENT],
})
export class AwsClientsModule {}
