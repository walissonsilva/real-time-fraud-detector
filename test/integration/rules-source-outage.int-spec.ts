import { AlertRepository, OutboxEntry } from '../../src/alerts/alert.repository';
import { FraudAlert } from '../../src/alerts/fraud-alert';
import { OutboxEntryPublisherService } from '../../src/alerts/outbox-entry-publisher.service';
import { SnsEventBus } from '../../src/alerts/sns-event-bus';
import { JsonLogger } from '../../src/observability/logger';
import { InMemoryMetrics } from '../../src/observability/metrics';
import { AppConfigRuleRepository } from '../../src/rules/appconfig-rule.repository';
import { DeclarativeRuleEngine } from '../../src/rules/declarative-rule-engine';
import { ConfigClientError, ConfigPollResult, RuleConfigClient } from '../../src/rules/rule-source';
import { ProcessTransactionService } from '../../src/transactions/process-transaction.service';
import { IngestedEvent, TransactionEvent } from '../../src/transactions/transaction-event';
import { readExample } from './support';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rulesJson = readFileSync(join(__dirname, '../../config/rules.json'), 'utf8');

/** Responde com as regras na partida e, depois, simula a queda total do AppConfig. */
class OutageClient implements RuleConfigClient {
  down = false;
  failures = 0;
  async start() {}
  async poll(): Promise<ConfigPollResult> {
    if (this.down) {
      this.failures += 1;
      throw new ConfigClientError('UNAVAILABLE');
    }
    return { kind: 'changed', content: rulesJson, versionLabel: '20261010120000' };
  }
}

class FakeAlerts {
  alerts = new Map<string, FraudAlert>();
  pending = new Map<string, OutboxEntry>();
  async saveWithOutbox(alert: FraudAlert, traceparent?: string) {
    if (this.alerts.has(alert.dedupeKey)) return false;
    this.alerts.set(alert.dedupeKey, alert);
    this.pending.set(alert.dedupeKey, { alert, traceparent, attempts: 0 });
    return true;
  }
  async markPublished(alertId: string) {
    for (const [k, e] of this.pending) if (e.alert.alertId === alertId) this.pending.delete(k);
  }
  async recordPublishFailure() {}
  async claimPendingOutbox() {
    return [...this.pending.values()];
  }
  async findPendingByDedupeKey(key: string) {
    return this.pending.get(key) ?? null;
  }
  async countPendingOutbox() {
    return { pending: this.pending.size, oldestAgeMs: 0 };
  }
}

describe('AppConfig indisponível em runtime (SC-003)', () => {
  it('o processamento segue com a última revisão válida, sem exceção e sem perda de alertas', async () => {
    const logger = new JsonLogger(() => undefined);
    const metrics = new InMemoryMetrics();
    const engine = new DeclarativeRuleEngine();
    const client = new OutageClient();
    const rules = new AppConfigRuleRepository(client, engine, logger, metrics, { pollIntervalMs: 5, startupTimeoutMs: 5000 });
    await rules.start();

    const alerts = new FakeAlerts();
    const bus = { publishAlert: jest.fn(async () => undefined) };
    const publisher = new OutboxEntryPublisherService(alerts as unknown as AlertRepository, bus as unknown as SnsEventBus, logger, metrics);
    const useCase = new ProcessTransactionService(rules, engine, alerts as unknown as AlertRepository, publisher, logger, metrics);

    const base = readExample('transaction-event.authorized.valid.json') as TransactionEvent;
    const event = (i: number): IngestedEvent => ({
      event: { ...base, transactionId: `tx-outage-${i}`, amount: { minorUnits: 2_000_000, currency: 'BRL' } } as TransactionEvent,
      ingestedAt: new Date(),
      consumedAt: new Date(),
    });

    client.down = true; // a partir daqui toda consulta falha
    const outcomes: string[] = [];
    const started = Date.now();
    for (let i = 0; i < 300; i++) {
      outcomes.push(await useCase.execute(event(i)));
      if (i % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 10)); // deixa o laço de consulta falhar
    }
    const elapsedMs = Date.now() - started;
    rules.onModuleDestroy();

    expect(outcomes.every((o) => o === 'ALERT_CREATED')).toBe(true);
    expect(alerts.alerts.size).toBe(300);
    expect(await rules.currentRevision()).toBe(20261010120000);
    expect(client.failures).toBeGreaterThan(0);
    expect(metrics.counter('rules_refresh_failures_total')).toBeGreaterThan(0);
    expect(elapsedMs / 300).toBeLessThan(50); // ordem de grandeza: sem espera por rede no caminho crítico
  });
});
