import { InMemoryMetrics } from '../../observability/metrics';
import type { JsonLogger } from '../../observability/logger';
import type { AlertRepository, OutboxEntry } from '../alert.repository';
import { OutboxEntryPublisherService } from '../outbox-entry-publisher.service';
import type { SnsEventBus } from '../sns-event-bus';

describe('OutboxEntryPublisherService: linha alert.published', () => {
  const entry = {
    alert: { alertId: 'alert-1', traceId: 'trace-1', severity: 'HIGH', ingestedAt: '2026-10-12T10:00:00.000Z' },
    traceparent: undefined,
  } as unknown as OutboxEntry;

  function setup(publishAlert: () => Promise<void>) {
    const info = jest.fn();
    const warn = jest.fn();
    const logger = { info, warn, error: jest.fn() } as unknown as JsonLogger;
    const alerts = { markPublished: jest.fn().mockResolvedValue(undefined), recordPublishFailure: jest.fn().mockResolvedValue(undefined) } as unknown as AlertRepository;
    const bus = { publishAlert } as unknown as SnsEventBus;
    const service = new OutboxEntryPublisherService(alerts, bus, logger, new InMemoryMetrics());
    service.now = () => new Date('2026-10-12T10:00:00.250Z');
    return { service, info, warn };
  }

  it('registra a latência até o aceite, sem PII, quando o SNS aceita', async () => {
    const { service, info } = setup(() => Promise.resolve());
    await expect(service.publish(entry)).resolves.toBe(true);
    expect(info).toHaveBeenCalledWith('alert.published', { alertId: 'alert-1', traceId: 'trace-1', severity: 'HIGH', latencyMs: 250 });
  });

  it('não registra a linha quando a publicação falha', async () => {
    const { service, info } = setup(() => Promise.reject(new Error('boom')));
    await expect(service.publish(entry)).resolves.toBe(false);
    expect(info).not.toHaveBeenCalled();
  });
});
