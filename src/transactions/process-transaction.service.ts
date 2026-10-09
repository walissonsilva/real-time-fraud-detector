import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { consolidate } from '../alerts/decision';
import { dedupeKeyOf } from '../alerts/dedupe-key';
import { FraudAlert, TransactionSummary } from '../alerts/fraud-alert';
import { IngestedEvent, TransactionEvent } from './transaction-event';
import { OutboxEntryPublisherService } from '../alerts/outbox-entry-publisher.service';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { AlertRepository } from '../alerts/alert.repository';
import { DeclarativeRuleEngine } from '../rules/declarative-rule-engine';
import { StaticRuleRepository } from '../rules/static-rule.repository';

/** Falha transitória no processamento; `stage` indica a etapa para a DLQ (DlqMessage.stage). */
export class ProcessingError extends Error {
  constructor(
    readonly stage: 'RULE_EVALUATION' | 'PERSISTENCE',
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : `falha em ${stage}`);
    this.name = 'ProcessingError';
  }
}

export type ProcessOutcome = 'REVERSAL_SKIPPED' | 'NO_ALERT' | 'ALERT_CREATED' | 'DUPLICATE';

const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

function summarize(tx: TransactionEvent): TransactionSummary {
  return {
    transactionType: tx.transactionType,
    channel: tx.channel,
    amount: tx.amount,
    ...(tx.counterparty?.idToken ? { counterpartyIdToken: tx.counterparty.idToken } : {}),
    ...(tx.merchant?.country ? { merchantCountry: tx.merchant.country } : {}),
  };
}

/**
 * Evento válido → decisão stateless → alerta único por transação (outbox) → publicação imediata.
 * Lança apenas em falhas transitórias (avaliação, persistência): o consumidor decide retentar (FR-003a).
 * Falha na publicação NÃO lança: o alerta já está durável e o relay assume.
 */
@Injectable()
export class ProcessTransactionService {
  /** Relógio e gerador de id substituíveis em testes (determinismo). */
  now: () => Date = () => new Date();
  newId: () => string = randomUUID;

  constructor(
    private readonly rules: StaticRuleRepository,
    private readonly engine: DeclarativeRuleEngine,
    private readonly alerts: AlertRepository,
    private readonly publisher: OutboxEntryPublisherService,
    private readonly logger: JsonLogger,
    private readonly metrics: InMemoryMetrics,
  ) {}

  async execute(msg: IngestedEvent): Promise<ProcessOutcome> {
    const { logger, metrics } = this;
    const tx = msg.event;
    const traceId = tx.traceId ?? (msg.traceparent ? TRACEPARENT.exec(msg.traceparent)?.[1] : undefined);

    // Estorno: validado, mas não avaliado e sem alerta (FR-010a)
    if (tx.eventType === 'TRANSACTION_REVERSED') {
      metrics.increment('events_processed_total', { result: 'reversal_skipped' });
      return 'REVERSAL_SKIPPED';
    }

    let matches;
    try {
      const snapshot = await this.rules.loadActiveSnapshot();
      matches = this.engine.evaluate(snapshot.rules, tx);
    } catch (err) {
      throw new ProcessingError('RULE_EVALUATION', err);
    }
    const decision = consolidate(
      matches.map((m) => ({
        weight: m.rule.weight,
        triggered: {
          ruleId: m.rule.ruleId,
          ruleVersion: m.rule.version,
          name: m.rule.name,
          severity: m.rule.severity,
          reason: m.reason ?? m.rule.reason,
          ...(m.evidence && Object.keys(m.evidence).length ? { evidence: m.evidence } : {}),
        },
      })),
    );

    if (!decision.suspicious) {
      metrics.increment('events_processed_total', { result: 'no_alert' });
      return 'NO_ALERT';
    }

    const alert: FraudAlert = {
      schemaVersion: '1.0',
      alertId: this.newId(),
      dedupeKey: dedupeKeyOf(tx.transactionId),
      transactionId: tx.transactionId,
      customerId: tx.customerId,
      accountId: tx.accountId,
      severity: decision.severity!,
      score: decision.score,
      status: 'OPEN',
      triggeredRules: decision.triggeredRules,
      transaction: summarize(tx),
      transactionOccurredAt: tx.occurredAt,
      ingestedAt: msg.ingestedAt.toISOString(),
      consumedAt: msg.consumedAt.toISOString(),
      detectedAt: this.now().toISOString(),
      degraded: false,
      late: false,
      ...(traceId ? { traceId } : {}),
    };

    let created: boolean;
    try {
      created = await this.alerts.saveWithOutbox(alert, msg.traceparent);
    } catch (err) {
      throw new ProcessingError('PERSISTENCE', err);
    }

    if (created) {
      metrics.increment('alerts_total', { severity: alert.severity });
      metrics.increment('events_processed_total', { result: 'alert_created' });
      logger.info('alerta gerado', { alertId: alert.alertId, transactionId: tx.transactionId, severity: alert.severity, traceId });
      await this.publisher.publish({ alert, traceparent: msg.traceparent, attempts: 0 });
      return 'ALERT_CREATED';
    }

    // Reentrega: sem novo alerta; se a publicação ficou pendente, completa agora (FR-017a, D-04).
    metrics.increment('events_processed_total', { result: 'duplicate' });
    const pending = await this.alerts.findPendingByDedupeKey(alert.dedupeKey).catch((err: unknown) => {
      throw new ProcessingError('PERSISTENCE', err);
    });
    if (pending) await this.publisher.publish(pending);
    logger.info('evento duplicado: alerta já existente', { transactionId: tx.transactionId, traceId });
    return 'DUPLICATE';
  }
}
