import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InMemoryMetrics } from './metrics';

export interface MetricsLogOptions {
  readonly enabled: boolean;
  readonly intervalMs: number;
}

/**
 * Escreve a cada intervalo duas linhas JSON no stdout; o driver `awslogs` as envia ao CloudWatch Logs e filtros de
 * métrica (Terraform, `monitoring.tf`) as transformam em métricas:
 *  - `rules.metrics` → `FraudDetector/Rules` (research D-06): revisão ativa, idade do refresh, falhas e alertas;
 *  - `pipeline.metrics` → `FraudDetector/Pipeline`: vazão por resultado, entregas, DLQ e outbox (dashboard).
 * Sem dimensões nem identificadores de tarefa: a divergência entre instâncias sai de `MAX − MIN` do mesmo gauge,
 * sem alta cardinalidade nem PII. Gauges saem como valor corrente; contadores, como delta desde a emissão anterior.
 */
export class MetricsLogPublisher implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private readonly previous = new Map<string, number>();

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

  private delta(field: string, current: number): number {
    const value = Math.max(0, current - (this.previous.get(field) ?? 0));
    this.previous.set(field, current);
    return value;
  }

  private gaugeField(field: string, name: string, labels?: Record<string, string>): Record<string, number> {
    const value = this.metrics.gaugeValue(name, labels);
    return value !== undefined ? { [field]: value } : {};
  }

  private line(message: string, fields: Record<string, number>): string {
    return JSON.stringify({ level: 'info', time: new Date().toISOString(), message, ...fields });
  }

  private emit(): void {
    const m = this.metrics;

    this.write(
      this.line('rules.metrics', {
        ...this.gaugeField('RulesActiveRevision', 'rules_active_revision'),
        ...this.gaugeField('RulesLastRefreshAgeSeconds', 'rules_last_refresh_age_seconds'),
        RulesRefreshFailures: this.delta('RulesRefreshFailures', m.counterTotal('rules_refresh_failures_total')),
        AlertsCreated: this.delta('AlertsCreated', m.counterTotal('alerts_total')),
      }),
    );

    const processed = (result: string) => m.counterTotal('events_processed_total', { result });
    const delivery = (status: string) => m.counterTotal('deliveries_total', { status });
    this.write(
      this.line('pipeline.metrics', {
        EventsAlerted: this.delta('EventsAlerted', processed('alert_created')),
        EventsNoAlert: this.delta('EventsNoAlert', processed('no_alert') + processed('reversal_skipped')),
        EventsDuplicate: this.delta('EventsDuplicate', processed('duplicate')),
        EventsTransientFailure: this.delta('EventsTransientFailure', processed('transient_failure')),
        EventsRejected: this.delta('EventsRejected', m.counterTotal('events_rejected_total')),
        DeliveriesDelivered: this.delta('DeliveriesDelivered', delivery('delivered')),
        DeliveriesDeadLettered: this.delta('DeliveriesDeadLettered', delivery('dead_lettered')),
        DeliveriesInfraFailure: this.delta('DeliveriesInfraFailure', delivery('infra_failure')),
        DeliveriesFallback: this.delta('DeliveriesFallback', delivery('fallback')),
        DeliveriesDeferred: this.delta('DeliveriesDeferred', delivery('deferred')),
        ...this.gaugeField('BreakerAntifraud', 'circuit_breaker_state', { channel: 'ANTIFRAUD_QUEUE' }),
        ...this.gaugeField('BreakerPush', 'circuit_breaker_state', { channel: 'PUSH' }),
        ...this.gaugeField('BreakerSms', 'circuit_breaker_state', { channel: 'SMS' }),
        DlqMessages: this.delta('DlqMessages', m.counterTotal('dlq_total')),
        OutboxPublishFailures: this.delta('OutboxPublishFailures', m.counterTotal('outbox_publish_total', { result: 'failure' })),
        OutboxRepublished: this.delta('OutboxRepublished', m.counterTotal('outbox_relay_republished_total')),
        ...this.gaugeField('OutboxPending', 'outbox_pending'),
        ...this.gaugeField('OutboxOldestPendingAgeMs', 'outbox_oldest_pending_age_ms'),
      }),
    );
  }
}
