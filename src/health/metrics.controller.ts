import { Controller, Get, Header } from '@nestjs/common';
import { InMemoryMetrics } from '../observability/metrics';
import { AlertRepository } from '../alerts/alert.repository';

/**
 * Métricas em formato texto. `outbox_pending` e a idade da linha pendente mais antiga são lidas do banco
 * a cada consulta, para que o alarme (D-07) não dependa de o relay ter rodado recentemente. Sem PII (FR-027).
 */
@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: InMemoryMetrics,
    private readonly alerts: AlertRepository,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async render(): Promise<string> {
    try {
      const { pending, oldestAgeMs } = await this.alerts.countPendingOutbox();
      this.metrics.gauge('outbox_pending', pending);
      this.metrics.gauge('outbox_oldest_pending_age_ms', oldestAgeMs);
    } catch {
      // banco indisponível: expõe as métricas em memória sem os gauges do outbox
    }
    return this.metrics instanceof InMemoryMetrics ? this.metrics.render() : '';
  }
}
