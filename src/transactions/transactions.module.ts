import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { DlqModule } from '../dlq/dlq.module';
import { RulesModule } from '../rules/rules.module';
import { AjvTransactionEventValidator } from './ajv-transaction-event.validator';
import { ProcessTransactionService } from './process-transaction.service';
import { RejectInvalidEventService } from './reject-invalid-event.service';
import { SqsTransactionConsumer } from './sqs-transaction.consumer';

@Module({
  imports: [AlertsModule, RulesModule, DlqModule],
  providers: [
    { provide: AjvTransactionEventValidator, useFactory: () => new AjvTransactionEventValidator() },
    ProcessTransactionService,
    RejectInvalidEventService,
    SqsTransactionConsumer,
  ],
  exports: [ProcessTransactionService, SqsTransactionConsumer],
})
export class TransactionsModule {}
