import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FraudAlert } from '../alerts/fraud-alert';
import { IngestedEvent, TransactionEvent } from './transaction-event';
import { DeclarativeRuleEngine } from '../rules/declarative-rule-engine';
import { loadRulesConfig } from '../rules/rules-config.loader';
import { StaticRuleRepository } from '../rules/static-rule.repository';
import { OutboxEntryPublisherService } from '../alerts/outbox-entry-publisher.service';
import { ProcessTransactionService } from './process-transaction.service';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { AlertRepository, OutboxEntry } from '../alerts/alert.repository';
import { SnsEventBus } from '../alerts/sns-event-bus';

const root = join(__dirname, '../..');
const engine = new DeclarativeRuleEngine();
const snapshot = loadRulesConfig(join(root, 'config/rules.json'), engine);
const base = JSON.parse(
  readFileSync(join(root, 'docs/contratos/examples/transaction-event.authorized.valid.json'), 'utf8'),
) as TransactionEvent;

const noopLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as JsonLogger;
const metrics = { increment: jest.fn(), gauge: jest.fn(), observe: jest.fn() } as unknown as InMemoryMetrics;

class FakeRepo {
  alerts = new Map<string, FraudAlert>();
  pending = new Map<string, OutboxEntry>();
  published: string[] = [];
  failures: string[] = [];
  saveError?: Error;
  markError?: Error;

  async saveWithOutbox(alert: FraudAlert, traceparent?: string) {
    if (this.saveError) throw this.saveError;
    if (this.alerts.has(alert.dedupeKey)) return false;
    this.alerts.set(alert.dedupeKey, alert);
    this.pending.set(alert.dedupeKey, { alert, traceparent, attempts: 0 });
    return true;
  }
  async markPublished(alertId: string) {
    if (this.markError) throw this.markError;
    this.published.push(alertId);
    for (const [k, e] of this.pending) if (e.alert.alertId === alertId) this.pending.delete(k);
  }
  async recordPublishFailure(alertId: string, code: string) {
    this.failures.push(`${alertId}:${code}`);
  }
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

const ingested = (patch: Record<string, unknown> = {}): IngestedEvent => ({
  event: { ...base, ...patch } as TransactionEvent,
  ingestedAt: new Date('2026-10-08T10:00:00.000Z'),
  consumedAt: new Date('2026-10-08T10:00:00.050Z'),
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
});

const suspicious = { amount: { minorUnits: 2_000_000, currency: 'BRL' } };
const harmless = { amount: { minorUnits: 100, currency: 'BRL' }, counterparty: undefined };

function setup(opts: { busError?: Error; evalError?: Error } = {}) {
  const repo = new FakeRepo();
  const bus = {
    calls: [] as FraudAlert[],
    publishAlert: jest.fn(async (a: FraudAlert) => {
      if (opts.busError) throw opts.busError;
      bus.calls.push(a);
    }),
  };
  const clock = () => new Date('2026-10-08T10:00:00.200Z');
  const publisher = new OutboxEntryPublisherService(repo as unknown as AlertRepository, bus as unknown as SnsEventBus, noopLogger, metrics);
  publisher.now = clock;
  const evalEngine = opts.evalError
    ? { validate: jest.fn(), evaluate: jest.fn(() => { throw opts.evalError; }) }
    : engine;
  const useCase = new ProcessTransactionService(
    new StaticRuleRepository(snapshot),
    evalEngine as unknown as DeclarativeRuleEngine,
    repo as unknown as AlertRepository,
    publisher,
    noopLogger,
    metrics,
  );
  useCase.now = clock;
  useCase.newId = (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })();
  return { repo, bus, useCase };
}

describe('ProcessTransactionService', () => {
  it('suspeito: grava alerta+outbox, publica imediatamente e marca como publicado', async () => {
    const { repo, bus, useCase } = setup();
    await expect(useCase.execute(ingested(suspicious))).resolves.toBe('ALERT_CREATED');

    expect(repo.alerts.size).toBe(1);
    expect(bus.calls).toHaveLength(1);
    const published = bus.calls[0];
    expect(published).toMatchObject({
      schemaVersion: '1.0',
      status: 'OPEN',
      transactionId: base.transactionId,
      severity: 'HIGH',
      score: 40 + 25,
      publishedAt: '2026-10-08T10:00:00.200Z',
      latencyMs: 200,
      traceId: base.traceId,
    });
    expect(published.triggeredRules.map((r) => r.ruleId).sort()).toEqual(['high-amount', 'high-value-new-counterparty']);
    expect(repo.published).toEqual([published.alertId]);
  });

  it('o alerta publicado não traz dados de origem nem ids além dos do contrato', async () => {
    const { bus, useCase } = setup();
    await useCase.execute(ingested({ ...suspicious, origin: { ipAddress: '203.0.113.7' } }));
    expect(JSON.stringify(bus.calls[0])).not.toContain('203.0.113.7');
  });

  it('sem suspeita: nenhum alerta, nada publicado', async () => {
    const { repo, bus, useCase } = setup();
    await expect(useCase.execute(ingested(harmless))).resolves.toBe('NO_ALERT');
    expect(repo.alerts.size).toBe(0);
    expect(bus.calls).toHaveLength(0);
  });

  it('estorno: concluído sem avaliar regras e sem alerta', async () => {
    const evaluate = jest.spyOn(engine, 'evaluate');
    evaluate.mockClear();
    const { repo, useCase } = setup();
    await expect(useCase.execute(ingested({ ...suspicious, eventType: 'TRANSACTION_REVERSED' }))).resolves.toBe('REVERSAL_SKIPPED');
    expect(evaluate).not.toHaveBeenCalled();
    expect(repo.alerts.size).toBe(0);
    evaluate.mockRestore();
  });

  it('recusado é avaliado como autorizado', async () => {
    const { repo, useCase } = setup();
    await expect(useCase.execute(ingested({ ...suspicious, eventType: 'TRANSACTION_DECLINED', declineReason: 'INSUFFICIENT_FUNDS' }))).resolves.toBe('ALERT_CREATED');
    expect(repo.alerts.size).toBe(1);
  });

  it('duplicata: não cria novo alerta nem republica quando já foi publicado', async () => {
    const { repo, bus, useCase } = setup();
    await useCase.execute(ingested(suspicious));
    await expect(useCase.execute(ingested({ ...suspicious, eventId: '11111111-1111-4111-8111-111111111111' }))).resolves.toBe('DUPLICATE');
    expect(repo.alerts.size).toBe(1);
    expect(bus.calls).toHaveLength(1);
  });

  it('duplicata com outbox pendente: completa a publicação (D-04)', async () => {
    const failing = setup({ busError: Object.assign(new Error('x'), { code: 'SnsDown' }) });
    await expect(failing.useCase.execute(ingested(suspicious))).resolves.toBe('ALERT_CREATED');
    expect(failing.repo.pending.size).toBe(1);

    const { repo, bus, useCase } = setup();
    // reaproveita o estado pendente do repositório anterior
    repo.alerts = failing.repo.alerts;
    repo.pending = failing.repo.pending;
    await expect(useCase.execute(ingested(suspicious))).resolves.toBe('DUPLICATE');
    expect(bus.calls).toHaveLength(1);
    expect(repo.pending.size).toBe(0);
  });

  it('falha do SnsEventBus não falha o processamento: registra no outbox para o relay', async () => {
    const { repo, useCase } = setup({ busError: Object.assign(new Error('boom'), { code: 'SnsDown' }) });
    await expect(useCase.execute(ingested(suspicious))).resolves.toBe('ALERT_CREATED');
    expect(repo.alerts.size).toBe(1);
    expect(repo.published).toEqual([]);
    expect(repo.failures).toHaveLength(1);
    expect(repo.failures[0]).toMatch(/:SnsDown$/);
  });

  it('falha ao marcar como publicado não falha o processamento', async () => {
    const { repo, useCase } = setup();
    repo.markError = new Error('db');
    await expect(useCase.execute(ingested(suspicious))).resolves.toBe('ALERT_CREATED');
  });

  it('erro de avaliação propaga (falha transitória) e não grava nada', async () => {
    const { repo, useCase } = setup({ evalError: new Error('regra quebrou') });
    await expect(useCase.execute(ingested(suspicious))).rejects.toMatchObject({ name: 'ProcessingError', stage: 'RULE_EVALUATION', message: 'regra quebrou' });
    expect(repo.alerts.size).toBe(0);
  });

  it('erro de persistência propaga (falha transitória) e não publica', async () => {
    const { repo, bus, useCase } = setup();
    repo.saveError = new Error('db fora');
    await expect(useCase.execute(ingested(suspicious))).rejects.toMatchObject({ name: 'ProcessingError', stage: 'PERSISTENCE', message: 'db fora' });
    expect(bus.calls).toHaveLength(0);
  });

  it('é determinístico: mesma entrada, mesma decisão, qualquer ordem', async () => {
    const a = setup();
    const b = setup();
    await a.useCase.execute(ingested(harmless));
    await a.useCase.execute(ingested(suspicious));
    await b.useCase.execute(ingested(suspicious));
    const [x] = a.bus.calls;
    const [y] = b.bus.calls;
    expect({ ...x, alertId: 0 }).toEqual({ ...y, alertId: 0 });
  });
});
