import { MetricLabels, Metrics } from '../../application/ports/observability.port';

const keyOf = (name: string, labels: MetricLabels = {}) =>
  name +
  (Object.keys(labels).length
    ? `{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    : '');

/** Registro em memória; exposto em formato texto pelo endpoint de métricas. Sem PII nos rótulos. */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly observations = new Map<string, { count: number; sum: number; max: number }>();

  increment(name: string, labels?: MetricLabels, by = 1) {
    const key = keyOf(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  gauge(name: string, value: number, labels?: MetricLabels) {
    this.gauges.set(keyOf(name, labels), value);
  }

  observe(name: string, value: number, labels?: MetricLabels) {
    const key = keyOf(name, labels);
    const current = this.observations.get(key) ?? { count: 0, sum: 0, max: 0 };
    this.observations.set(key, { count: current.count + 1, sum: current.sum + value, max: Math.max(current.max, value) });
  }

  counter(name: string, labels?: MetricLabels): number {
    return this.counters.get(keyOf(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    for (const [k, v] of this.observations) {
      lines.push(`${k}_count ${v.count}`, `${k}_sum ${v.sum}`, `${k}_max ${v.max}`);
    }
    return lines.join('\n') + '\n';
  }
}
