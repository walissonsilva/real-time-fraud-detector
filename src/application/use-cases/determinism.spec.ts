import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AlertRepository, OutboxEntry } from '../ports/alert-repository.port';
import { EventBus } from '../ports/event-bus.port';
import { Logger, Metrics } from '../ports/observability.port';
import { FraudAlert } from '../../domain/alert/fraud-alert';
import { IngestedEvent, TransactionEvent } from '../../domain/transaction/transaction-event';
import { DeclarativeRuleEngine } from '../../infrastructure/rules/declarative-rule-engine';
import { loadRulesConfig } from '../../infrastructure/rules/rules-config.loader';
import { StaticRuleRepository } from '../../infrastructure/rules/static-rule.repository';
import { ProcessTransaction } from './process-transaction';
import { OutboxEntryPublisher } from './publish-outbox-entry';

const root = join(__dirname, '../../..');
const engine = new DeclarativeRuleEngine();
const rules = new StaticRuleRepository(loadRulesConfig(join(root, 'config/rules.json'), engine));
const base = JSON.parse(readFileSync(join(root, 'docs/contratos/examples/transaction-event.authorized.valid.json'), 'utf8')) as TransactionEvent;

const logger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const metrics: Metrics = { increment: jest.fn(), gauge: jest.fn(), observe: jest.fn() };

class MemoryRepo implements AlertRepository {
  alerts = new Map<string, FraudAlert>();
  async saveWithOutbox(alert: FraudAlert) {
    if (this.alerts.has(alert.dedupeKey)) return false;
    this.alerts.set(alert.dedupeKey, alert);
    return true;
  }
  async markPublished() {}
  async recordPublishFailure() {}
  async claimPendingOutbox(): Promise<OutboxEntry[]> {
    return [];
  }
  async findPendingByDedupeKey() {
    return null;
  }
  async countPendingOutbox() {
    return { pending: 0, oldestAgeMs: 0 };
  }
}

/** Gerador pseudoaleatório determinístico (mulberry32) para que o teste seja reproduzível. */
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AMOUNTS = [100, 50_000, 999_999, 1_000_000, 2_000_000, 9_000_000];
const COUNTRIES = ['BR', 'US', 'KP', 'IR', 'RU'];
const CHANNELS = ['MOBILE_APP', 'WEB', 'ATM', 'POS'];
const TYPES = ['PIX', 'TED', 'CARD', 'BOLETO'];

function makeEvents(n: number, rand: () => number): TransactionEvent[] {
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  return Array.from({ length: n }, (_, i) => ({
    ...base,
    eventId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    transactionId: `tx-det-${i}`,
    amount: { minorUnits: pick(AMOUNTS), currency: 'BRL' },
    channel: pick(CHANNELS),
    transactionType: pick(TYPES),
    ...(rand() < 0.5 ? { counterparty: undefined } : {}),
    merchant: { country: pick(COUNTRIES) },
  })) as unknown as TransactionEvent[];
}

const ingested = (event: TransactionEvent): IngestedEvent => ({
  event,
  ingestedAt: new Date('2026-10-08T10:00:00.000Z'),
  consumedAt: new Date('2026-10-08T10:00:00.050Z'),
});

/** Executa os eventos na ordem dada e devolve a decisão por transação (sem ids gerados). */
async function decide(events: TransactionEvent[]) {
  const repo = new MemoryRepo();
  const bus: EventBus = { publishAlert: async () => undefined };
  const clock = () => new Date('2026-10-08T10:00:00.200Z');
  const publisher = new OutboxEntryPublisher({ alerts: repo, bus, logger, metrics, clock });
  const useCase = new ProcessTransaction({ rules, engine, alerts: repo, publisher, logger, metrics, clock, newId: () => '00000000-0000-4000-8000-0000000000aa' });
  for (const e of events) await useCase.execute(ingested(e));
  const decisions = new Map<string, unknown>();
  for (const a of repo.alerts.values()) {
    decisions.set(a.transactionId, { severity: a.severity, score: a.score, rules: a.triggeredRules.map((r) => [r.ruleId, r.ruleVersion, r.evidence]) });
  }
  return decisions;
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('determinismo (SC-003, FR-011)', () => {
  const rand = prng(42);
  const events = makeEvents(200, rand);

  it('o conjunto de eventos exercita alertas e não-alertas', async () => {
    const decisions = await decide(events);
    expect(decisions.size).toBeGreaterThan(10);
    expect(decisions.size).toBeLessThan(events.length);
  });

  it('a decisão de cada evento independe da ordem em que os eventos chegam', async () => {
    const reference = await decide(events);
    for (let round = 0; round < 5; round++) {
      expect(await decide(shuffle(events, rand))).toEqual(reference);
    }
  });

  it('repetições (reentrega) não mudam a decisão nem criam alertas extras', async () => {
    const reference = await decide(events);
    const withRepeats = [...events, ...shuffle(events, rand), ...events.slice(0, 50)];
    expect(await decide(withRepeats)).toEqual(reference);
  });

  it('um evento isolado decide igual a quando está intercalado com outros', async () => {
    const reference = await decide(events);
    for (const e of events.slice(0, 30)) {
      const alone = await decide([e]);
      expect(alone.get(e.transactionId)).toEqual(reference.get(e.transactionId));
    }
  });
});
