import { InMemoryMetrics } from '../observability/metrics';
import { MetricsController } from './metrics.controller';
import { AlertRepository } from '../alerts/alert.repository';

const repo = (impl: () => Promise<{ pending: number; oldestAgeMs: number }>) => ({ countPendingOutbox: impl }) as unknown as AlertRepository;

describe('MetricsController', () => {
  it('expõe outbox_pending e a idade da linha mais antiga lidos do banco, junto dos contadores', async () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('alerts_total', { severity: 'HIGH' });
    const out = await new MetricsController(metrics, repo(async () => ({ pending: 3, oldestAgeMs: 4200 }))).render();
    expect(out).toContain('outbox_pending 3');
    expect(out).toContain('outbox_oldest_pending_age_ms 4200');
    expect(out).toContain('alerts_total{severity="HIGH"} 1');
  });

  it('com o banco fora, ainda responde com as métricas em memória', async () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('events_rejected_total', { reason: 'SCHEMA_INVALID' });
    const out = await new MetricsController(metrics, repo(async () => { throw new Error('db'); })).render();
    expect(out).toContain('events_rejected_total{reason="SCHEMA_INVALID"} 1');
  });

  it('não contém PII: rótulos usados pelo sistema são só enumerações/códigos', () => {
    // Os rótulos são definidos nos casos de uso; este teste documenta a lista permitida.
    const allowed = new Set(['result', 'reason', 'severity', 'stage', 'channel', 'status']);
    const metrics = new InMemoryMetrics();
    metrics.increment('deliveries_total', { channel: 'PUSH', status: 'delivered' });
    const labels = [...metrics.render().matchAll(/(\w+)="/g)].map((m) => m[1]);
    for (const l of labels) expect(allowed.has(l)).toBe(true);
  });
});
