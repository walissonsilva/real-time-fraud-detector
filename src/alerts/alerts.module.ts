import { Module } from '@nestjs/common';
import { AlertRepository } from './alert.repository';
import { OutboxEntryPublisherService } from './outbox-entry-publisher.service';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import { RelayOutboxService } from './relay-outbox.service';
import { SnsEventBus } from './sns-event-bus';

@Module({
  providers: [AlertRepository, SnsEventBus, OutboxEntryPublisherService, RelayOutboxService, OutboxRelayScheduler],
  exports: [AlertRepository, OutboxEntryPublisherService, RelayOutboxService, OutboxRelayScheduler],
})
export class AlertsModule {}
