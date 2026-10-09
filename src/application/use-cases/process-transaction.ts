import { randomUUID } from 'node:crypto';
import { AlertRepository } from '../ports/alert-repository.port';
import { Logger, Metrics } from '../ports/observability.port';
import { RuleEngine } from '../ports/rule-engine.port';
import { RuleRepository } from '../ports/rule-repository.port';
import { consolidate } from '../../domain/alert/decision';
import { dedupeKeyOf } from '../../domain/alert/dedupe-key';
import { FraudAlert, TransactionSummary } from '../../domain/alert/fraud-alert';
import { IngestedEvent, TransactionEvent } from '../../domain/transaction/transaction-event';
import { OutboxEntryPublisher } from './publish-outbox-entry';

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

export interface ProcessTransactionDeps {
  readonly rules: RuleRepository;
  readonly engine: RuleEngine;
  readonly alerts: AlertRepository;
  readonly publisher: OutboxEntryPublisher;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

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
export class ProcessTransaction {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: ProcessTransactionDeps) {
    this.now = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  async execute(msg: IngestedEvent): Promise<ProcessOutcome> {
    const { logger, metrics } = this.deps;
    const tx = msg.event;
    const traceId = tx.traceId ?? (msg.traceparent ? TRACEPARENT.exec(msg.traceparent)?.[1] : undefined);

    // Estorno: validado, mas não avaliado e sem alerta (FR-010a)
    if (tx.eventType === 'TRANSACTION_REVERSED') {
      metrics.increment('events_processed_total', { result: 'reversal_skipped' });
      return 'REVERSAL_SKIPPED';
    }

    let matches;
    try {
      const snapshot = await this.deps.rules.loadActiveSnapshot();
      matches = this.deps.engine.evaluate(snapshot.rules, tx);
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
      created = await this.deps.alerts.saveWithOutbox(alert, msg.traceparent);
    } catch (err) {
      throw new ProcessingError('PERSISTENCE', err);
    }

    if (created) {
      metrics.increment('alerts_total', { severity: alert.severity });
      metrics.increment('events_processed_total', { result: 'alert_created' });
      logger.info('alerta gerado', { alertId: alert.alertId, transactionId: tx.transactionId, severity: alert.severity, traceId });
      await this.deps.publisher.publish({ alert, traceparent: msg.traceparent, attempts: 0 });
      return 'ALERT_CREATED';
    }

    // Reentrega: sem novo alerta; se a publicação ficou pendente, completa agora (FR-017a, D-04).
    metrics.increment('events_processed_total', { result: 'duplicate' });
    const pending = await this.deps.alerts.findPendingByDedupeKey(alert.dedupeKey).catch((err: unknown) => {
      throw new ProcessingError('PERSISTENCE', err);
    });
    if (pending) await this.deps.publisher.publish(pending);
    logger.info('evento duplicado: alerta já existente', { transactionId: tx.transactionId, traceId });
    return 'DUPLICATE';
  }
}
