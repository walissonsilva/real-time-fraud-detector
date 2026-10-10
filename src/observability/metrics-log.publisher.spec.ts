import { InMemoryMetrics } from './metrics';
import { MetricsLogPublisher } from './metrics-log.publisher';

type Line = Record<string, unknown>;

function setup(enabled = true) {
  const lines: Line[] = [];
  const metrics = new InMemoryMetrics();
  const publisher = new MetricsLogPublisher(metrics, { enabled, intervalMs: 60_000 }, (l) => lines.push(JSON.parse(l) as Line));
  return { lines, metrics, publisher };
}

describe('MetricsLogPublisher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a cada intervalo escreve uma linha rules.metrics com gauges e deltas, sem dimensões', () => {
    const { lines, metrics, publisher } = setup();
    metrics.gauge('rules_active_revision', 20261010120000);
    metrics.gauge('rules_last_refresh_age_seconds', 12);
    metrics.increment('rules_refresh_failures_total', undefined, 2);
    metrics.increment('alerts_total', { severity: 'HIGH' }, 5);
    metrics.increment('alerts_total', { severity: 'LOW' }, 3);
    publisher.onModuleInit();
    expect(lines).toHaveLength(0);

    jest.advanceTimersByTime(60_000);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'rules.metrics',
      RulesActiveRevision: 20261010120000,
      RulesLastRefreshAgeSeconds: 12,
      RulesRefreshFailures: 2,
      AlertsCreated: 8, // soma das severidades
    });
    expect(typeof lines[0].time).toBe('string');
    publisher.onModuleDestroy();
  });

  it('contadores saem como delta desde a emissão anterior', () => {
    const { lines, metrics, publisher } = setup();
    publisher.onModuleInit();
    metrics.increment('alerts_total', { severity: 'HIGH' }, 10);
    metrics.increment('rules_refresh_failures_total', undefined, 1);
    jest.advanceTimersByTime(60_000);
    metrics.increment('alerts_total', { severity: 'HIGH' }, 4);
    jest.advanceTimersByTime(60_000);
    jest.advanceTimersByTime(60_000);
    expect(lines.map((l) => l.AlertsCreated)).toEqual([10, 4, 0]);
    expect(lines.map((l) => l.RulesRefreshFailures)).toEqual([1, 0, 0]);
    publisher.onModuleDestroy();
  });

  it('omite os gauges ainda sem valor (ex.: antes da primeira revisão)', () => {
    const { lines, publisher } = setup();
    publisher.onModuleInit();
    jest.advanceTimersByTime(60_000);
    expect('RulesActiveRevision' in lines[0]).toBe(false);
    expect('RulesLastRefreshAgeSeconds' in lines[0]).toBe(false);
    expect(lines[0].RulesRefreshFailures).toBe(0);
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
    expect(JSON.stringify(lines[0])).not.toMatch(/acc-1|accountId|severity/);
    publisher.onModuleDestroy();
  });
});
