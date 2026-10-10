import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InMemoryMetrics } from './metrics';

export interface MetricsLogOptions {
  readonly enabled: boolean;
  readonly intervalMs: number;
}

/**
 * Escreve a cada intervalo uma linha JSON `rules.metrics` no stdout; o driver `awslogs` a envia ao CloudWatch Logs e
 * filtros de métrica (Terraform, `monitoring.tf`) a transformam nas métricas `FraudDetector/Rules` (research D-06).
 * Sem dimensões nem identificadores de tarefa: a divergência entre instâncias sai de `MAX − MIN` do mesmo gauge,
 * sem alta cardinalidade nem PII. Gauges: revisão ativa e idade do último refresh. Contadores saem como delta
 * desde a emissão anterior.
 */
export class MetricsLogPublisher implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private previousFailures = 0;
  private previousAlerts = 0;

  constructor(
    private readonly metrics: InMemoryMetrics,
    private readonly options: MetricsLogOptions,
    private readonly write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) return;
    this.timer = setInterval(() => this.emit(), this.options.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    const failures = this.metrics.counterTotal('rules_refresh_failures_total');
    const alerts = this.metrics.counterTotal('alerts_total');
    const revision = this.metrics.gaugeValue('rules_active_revision');
    const age = this.metrics.gaugeValue('rules_last_refresh_age_seconds');

    const line = {
      level: 'info',
      time: new Date().toISOString(),
      message: 'rules.metrics',
      ...(revision !== undefined ? { RulesActiveRevision: revision } : {}),
      ...(age !== undefined ? { RulesLastRefreshAgeSeconds: age } : {}),
      RulesRefreshFailures: Math.max(0, failures - this.previousFailures),
      AlertsCreated: Math.max(0, alerts - this.previousAlerts),
    };
    this.previousFailures = failures;
    this.previousAlerts = alerts;
    this.write(JSON.stringify(line));
  }
}
