import { Module } from '@nestjs/common';
import { SqsDlqPublisher } from './sqs-dlq.publisher';

@Module({
  providers: [SqsDlqPublisher],
  exports: [SqsDlqPublisher],
})
export class DlqModule {}
