import { randomUUID } from 'node:crypto';
import { SNSClient } from '@aws-sdk/client-sns';
import { Pool } from 'pg';
import { EventBus } from '../../src/application/ports/event-bus.port';
import { Logger, Metrics } from '../../src/application/ports/observability.port';
import { OutboxEntryPublisher } from '../../src/application/use-cases/publish-outbox-entry';
import { ProcessTransaction } from '../../src/application/use-cases/process-transaction';
import { RelayOutbox } from '../../src/application/use-cases/relay-outbox';
import { PostgresAlertRepository } from '../../src/infrastructure/persistence/postgres-alert.repository';
import { SnsEventBus } from '../../src/infrastructure/messaging/sns-event-bus';
import { DeclarativeRuleEngine } from '../../src/infrastructure/rules/declarative-rule-engine';
import { loadRulesConfig } from '../../src/infrastructure/rules/rules-config.loader';
import { StaticRuleRepository } from '../../src/infrastructure/rules/static-rule.repository';
import { CHANNEL_QUEUES, drain, ingested, newPool, newSqs, purge, suspiciousEvent } from './support';

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const metrics: Metrics = { increment: () => undefined, gauge: () => undefined, observe: () => undefined };

describe('outbox + SNS → SQS (requer infra:up e migrate)', () => {
  const runId = randomUUID().slice(0, 8);
  const pool: Pool = newPool();
  const sqs = newSqs();
  const sns = new SNSClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });
  const repo = new PostgresAlertRepository(pool);
  const engine = new DeclarativeRuleEngine();
  const rules = new StaticRuleRepository(loadRulesConfig('config/rules.json', engine));
  const realBus = new SnsEventBus(sns, { snsAlertsTopic: 'alerts.fifo', snsPublishTimeoutMs: 5000 });
  const transactionIds: string[] = [];

  const build = (bus: EventBus) => {
    const publisher = new OutboxEntryPublisher({ alerts: repo, bus, logger, metrics });
    return {
      process: new ProcessTransaction({ rules, engine, alerts: repo, publisher, logger, metrics }),
      relay: new RelayOutbox(repo, publisher, logger, metrics, { batchSize: 50, minAgeMs: 0 }),
    };
  };

  const rowFor = async (transactionId: string) =>
    (
      await pool.query(
        `SELECT a.alert_id, a.published_at AS a_pub, o.published_at AS o_pub, o.attempts, o.last_error, o.traceparent
           FROM alerts a JOIN outbox o USING (alert_id) WHERE a.transaction_id = $1`,
        [transactionId],
      )
    ).rows;

  const matchTx = (transactionId: string) => (b: Record<string, unknown>) => b.transactionId === transactionId;

  beforeAll(async () => {
    await purge(sqs, CHANNEL_QUEUES);
  });

  afterAll(async () => {
    if (transactionIds.length) {
      await pool.query('DELETE FROM outbox WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
      await pool.query('DELETE FROM alerts WHERE transaction_id = ANY($1)', [transactionIds]);
    }
    await pool.end();
    sqs.destroy();
    sns.destroy();
  });

  it('cenário 1: alerta e outbox atômicos; publicação imediata preenche published_at e chega aos dois canais', async () => {
    const event = suspiciousEvent(runId);
    transactionIds.push(event.transactionId);
    const { process } = build(realBus);

    await expect(process.execute(ingested(event))).resolves.toBe('ALERT_CREATED');

    const rows = await rowFor(event.transactionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].o_pub).not.toBeNull();
    expect(rows[0].a_pub).not.toBeNull();
    expect(rows[0].traceparent).toContain('4bf92f35');

    for (const queue of CHANNEL_QUEUES) {
      const msgs = await drain(sqs, queue, matchTx(event.transactionId));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ alertId: rows[0].alert_id, status: 'OPEN', schemaVersion: '1.0' });
      expect(typeof msgs[0].publishedAt).toBe('string');
      expect(typeof msgs[0].latencyMs).toBe('number');
    }
  });

  it('cenário 3: SNS indisponível → alerta pendente, evento concluído; o relay publica depois', async () => {
    const event = suspiciousEvent(runId);
    transactionIds.push(event.transactionId);
    const downBus: EventBus = {
      publishAlert: async () => {
        throw Object.assign(new Error('sns fora'), { code: 'ServiceUnavailable' });
      },
    };

    await expect(build(downBus).process.execute(ingested(event))).resolves.toBe('ALERT_CREATED');

    let [row] = await rowFor(event.transactionId);
    expect(row.o_pub).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('ServiceUnavailable');
    expect(await drain(sqs, CHANNEL_QUEUES[0], matchTx(event.transactionId), { rounds: 2 })).toHaveLength(0);

    // SNS restaurado: o backoff vence e o relay publica
    await pool.query('UPDATE outbox SET next_attempt_at = now() WHERE alert_id = $1', [row.alert_id]);
    const { relay } = build(realBus);
    expect(await relay.runOnce()).toBeGreaterThanOrEqual(1);

    [row] = await rowFor(event.transactionId);
    expect(row.o_pub).not.toBeNull();
    expect(row.a_pub).not.toBeNull();
    for (const queue of CHANNEL_QUEUES) {
      expect(await drain(sqs, queue, matchTx(event.transactionId))).toHaveLength(1);
    }
    const pending = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE alert_id = $1 AND published_at IS NULL', [row.alert_id]);
    expect(pending.rows[0].n).toBe(0);
  });

  it('cenário 4: reentrega sequencial e concorrente resultam em exatamente 1 alerta e 1 mensagem por canal (SC-002)', async () => {
    const event = suspiciousEvent(runId);
    transactionIds.push(event.transactionId);
    const { process } = build(realBus);

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => build(realBus).process.execute(ingested({ ...event, eventId: randomUUID() }))),
    );
    expect(outcomes.filter((o) => o === 'ALERT_CREATED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(11);
    await expect(process.execute(ingested(event))).resolves.toBe('DUPLICATE');

    expect(await rowFor(event.transactionId)).toHaveLength(1);
    for (const queue of CHANNEL_QUEUES) {
      const msgs = await drain(sqs, queue, matchTx(event.transactionId), { wantAtLeast: 2, rounds: 4 });
      expect(msgs).toHaveLength(1);
    }
  });

  it('reentrega com outbox pendente completa a publicação sem criar novo alerta (FR-017a)', async () => {
    const event = suspiciousEvent(runId);
    transactionIds.push(event.transactionId);
    const down: EventBus = { publishAlert: async () => { throw new Error('x'); } };
    await build(down).process.execute(ingested(event));
    expect((await rowFor(event.transactionId))[0].o_pub).toBeNull();

    await expect(build(realBus).process.execute(ingested({ ...event, eventId: randomUUID() }))).resolves.toBe('DUPLICATE');

    const rows = await rowFor(event.transactionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].o_pub).not.toBeNull();
    for (const queue of CHANNEL_QUEUES) expect(await drain(sqs, queue, matchTx(event.transactionId))).toHaveLength(1);
  });

  it('sem suspeita: nenhuma linha em alerts/outbox', async () => {
    const event = suspiciousEvent(runId, { amount: { minorUnits: 100, currency: 'BRL' }, counterparty: undefined });
    await expect(build(realBus).process.execute(ingested(event))).resolves.toBe('NO_ALERT');
    expect(await rowFor(event.transactionId)).toHaveLength(0);
  });
});
