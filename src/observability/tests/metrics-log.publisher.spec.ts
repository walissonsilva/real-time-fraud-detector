import { InMemoryMetrics } from '../metrics';
import { MetricsLogPublisher } from '../metrics-log.publisher';

type Line = Record<string, unknown>;

function setup(enabled = true) {
  const lines: Line[] = [];
  const metrics = new InMemoryMetrics();
  const publisher = new MetricsLogPublisher(metrics, { enabled, intervalMs: 60_000 }, (l) => lines.push(JSON.parse(l) as Line));
  const rules = () => lines.filter((l) => l.message === 'rules.metrics');
  const pipeline = () => lines.filter((l) => l.message === 'pipeline.metrics');
  return { lines, rules, pipeline, metrics, publisher };
}

describe('MetricsLogPublisher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a cada intervalo escreve uma linha rules.metrics com gauges e deltas, sem dimensões', () => {
    const { lines, rules, metrics, publisher } = setup();
    metrics.gauge('rules_active_revision', 20261010120000);
    metrics.gauge('rules_last_refresh_age_seconds', 12);
    metrics.increment('rules_refresh_failures_total', undefined, 2);
    metrics.increment('alerts_total', { severity: 'HIGH' }, 5);
    metrics.increment('alerts_total', { severity: 'LOW' }, 3);
    publisher.onModuleInit();
    expect(lines).toHaveLength(0);

    jest.advanceTimersByTime(60_000);

    expect(rules()).toHaveLength(1);
    expect(rules()[0]).toMatchObject({
      level: 'info',
      message: 'rules.metrics',
      RulesActiveRevision: 20261010120000,
      RulesLastRefreshAgeSeconds: 12,
      RulesRefreshFailures: 2,
      AlertsCreated: 8, // soma das severidades
    });
    expect(typeof rules()[0].time).toBe('string');
    publisher.onModuleDestroy();
  });

  it('contadores saem como delta desde a emissão anterior', () => {
    const { rules, metrics, publisher } = setup();
    publisher.onModuleInit();
    metrics.increment('alerts_total', { severity: 'HIGH' }, 10);
    metrics.increment('rules_refresh_failures_total', undefined, 1);
    jest.advanceTimersByTime(60_000);
    metrics.increment('alerts_total', { severity: 'HIGH' }, 4);
    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(60_000);
    expect(rules().map((l) => l.AlertsCreated)).toEqual([10, 4, 0]);
    expect(rules().map((l) => l.RulesRefreshFailures)).toEqual([1, 0, 0]);
    publisher.onModuleDestroy();
  });

  it('omite os gauges ainda sem valor (ex.: antes da primeira revisão)', () => {
    const { rules, pipeline, publisher } = setup();
    publisher.onModuleInit();
    jest.advanceTimersByTime(60_000);
    expect('RulesActiveRevision' in rules()[0]).toBe(false);
    expect('RulesLastRefreshAgeSeconds' in rules()[0]).toBe(false);
    expect(rules()[0].RulesRefreshFailures).toBe(0);
    expect('OutboxPending' in pipeline()[0]).toBe(false);
    publisher.onModuleDestroy();
  });

  it('desligado: não emite nada', () => {
    const { lines, publisher } = setup(false);
    publisher.onModuleInit();
    jest.advanceTimersByTime(300_000);
    expect(lines).toHaveLength(0);
    publisher.onModuleDestroy();
  });

  it('onModuleDestroy para as emissões', () => {
    const { lines, publisher } = setup();
    publisher.onModuleInit();
    publisher.onModuleDestroy();
    jest.advanceTimersByTime(300_000);
    expect(lines).toHaveLength(0);
  });

  it('a linha não carrega rótulos nem identificadores (sem alta cardinalidade nem PII)', () => {
    const { lines, metrics, publisher } = setup();
    metrics.increment('alerts_total', { severity: 'HIGH', accountId: 'acc-1' }, 1);
    publisher.onModuleInit();
    jest.advanceTimersByTime(60_000);
    expect(JSON.stringify(lines)).not.toMatch(/acc-1|accountId|severity/);
    publisher.onModuleDestroy();
  });

  it('pipeline.metrics separa eventos por resultado, entregas e DLQ (deltas) e repassa os gauges do outbox', () => {
    const { pipeline, metrics, publisher } = setup();
    metrics.increment('events_processed_total', { result: 'alert_created' }, 3);
    metrics.increment('events_processed_total', { result: 'no_alert' }, 100);
    metrics.increment('events_processed_total', { result: 'reversal_skipped' }, 7);
    metrics.increment('events_processed_total', { result: 'duplicate' }, 2);
    metrics.increment('events_rejected_total', { reason: 'SCHEMA' }, 1);
    metrics.increment('deliveries_total', { channel: 'antifraud-queue', status: 'delivered' }, 3);
    metrics.increment('deliveries_total', { channel: 'customer-push', status: 'delivered' }, 2);
    metrics.increment('deliveries_total', { channel: 'customer-push', status: 'dead_lettered' }, 1);
    metrics.increment('dlq_total', { stage: 'CHANNEL_DELIVERY' }, 1);
    metrics.gauge('outbox_pending', 4);
    metrics.gauge('outbox_oldest_pending_age_ms', 1500);
    publisher.onModuleInit();

    jest.advanceTimersByTime(60_000);
    metrics.increment('events_processed_total', { result: 'no_alert' }, 5);
    jest.advanceTimersByTime(60_000);

    expect(pipeline()[0]).toMatchObject({
      EventsAlerted: 3,
      EventsNoAlert: 107,
      EventsDuplicate: 2,
      EventsRejected: 1,
      DeliveriesDelivered: 5,
      DeliveriesDeadLettered: 1,
      DlqMessages: 1,
      OutboxPending: 4,
      OutboxOldestPendingAgeMs: 1500,
    });
    expect(pipeline()[1]).toMatchObject({ EventsNoAlert: 5, EventsAlerted: 0, DeliveriesDelivered: 0 });
    publisher.onModuleDestroy();
  });

  it('pipeline.metrics inclui fallback/adiadas (deltas) e o estado dos circuit breakers por canal (gauges)', () => {
    const { pipeline, metrics, publisher } = setup();
    metrics.increment('deliveries_total', { channel: 'PUSH', status: 'fallback' }, 4);
    metrics.increment('deliveries_total', { channel: 'PUSH', status: 'deferred' }, 6);
    metrics.gauge('circuit_breaker_state', 0, { channel: 'ANTIFRAUD_QUEUE' });
    metrics.gauge('circuit_breaker_state', 2, { channel: 'PUSH' });
    metrics.gauge('circuit_breaker_state', 1, { channel: 'SMS' });
    publisher.onModuleInit();

    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(60_000);

    expect(pipeline()[0]).toMatchObject({ DeliveriesFallback: 4, DeliveriesDeferred: 6, BreakerAntifraud: 0, BreakerPush: 2, BreakerSms: 1 });
    expect(pipeline()[1]).toMatchObject({ DeliveriesFallback: 0, DeliveriesDeferred: 0, BreakerPush: 2 });
    publisher.onModuleDestroy();
  });
});
