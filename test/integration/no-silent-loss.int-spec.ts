import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { deliveryIdOf } from '../../src/domain/alert/delivery-id';
import { CHANNEL_FAULTS, ChannelFaults } from '../../src/infrastructure/messaging/messaging.module';
import { drain, newPool, newSqs, purge, readExample } from './support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condição não satisfeita a tempo');
    await sleep(250);
  }
}

const CH_DLQ = { ANTIFRAUD_QUEUE: 'alert-deliveries-antifraud-queue-dlq.fifo', PUSH: 'alert-deliveries-customer-push-dlq.fifo' } as const;

describe('nenhuma perda silenciosa (SC-006) (requer infra:up e migrate)', () => {
  const runId = randomUUID().slice(0, 8);
  const sqs = newSqs();
  const pool: Pool = newPool();
  let app: INestApplication;
  let queueUrl: string;
  let faults: ChannelFaults;
  const ids: string[] = [];

  const tx = (kind: string) => `tx-loss-${runId}-${kind}-${randomUUID().slice(0, 6)}`;
  const publish = async (body: unknown) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: typeof body === 'string' ? body : JSON.stringify(body) }));
  };
  const base = () => ({ ...readExample('transaction-event.authorized.valid.json'), eventId: randomUUID(), accountId: `acc-loss-${runId}` });

  const inputEmpty = async () => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
    );
    return Attributes!.ApproximateNumberOfMessages === '0' && Attributes!.ApproximateNumberOfMessagesNotVisible === '0';
  };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://fraud:fraud@localhost:55432/fraud';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.RULES_CONFIG_PATH = 'config/rules.json';
    process.env.CHANNEL_DELIVERY_BASE_DELAY_MS = '20';
    process.env.CHANNEL_DELIVERY_MAX_DELAY_MS = '50';
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'transactions' }))).QueueUrl!;
    await purge(sqs, ['transactions', 'transactions-dlq', 'alert-deliveries-antifraud-queue.fifo', 'alert-deliveries-customer-push.fifo', ...Object.values(CH_DLQ)]);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    faults = app.get<ChannelFaults>(CHANNEL_FAULTS);
  });

  afterAll(async () => {
    await app.close();
    await pool.query('DELETE FROM deliveries WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM outbox WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM alerts WHERE transaction_id = ANY($1)', [ids]);
    await pool.end();
    sqs.destroy();
  });

  it('todo evento termina em exatamente um estado e toda entrega em DELIVERED ou DLQ', async () => {
    const suspiciousOk = [tx('alert-ok-1'), tx('alert-ok-2')];
    const suspiciousDead = [tx('alert-dead')];
    const harmless = [tx('harmless-1'), tx('harmless-2')];
    const reversed = [tx('reversed')];
    const invalid = [tx('invalid-schema'), tx('invalid-truncated')];
    const duplicated = tx('dup');
    ids.push(...suspiciousOk, ...suspiciousDead, ...harmless, ...reversed, ...invalid, duplicated);

    const big = { amount: { minorUnits: 2_000_000, currency: 'BRL' } };
    for (const t of suspiciousOk) await publish({ ...base(), transactionId: t, ...big });
    await publish({ ...base(), transactionId: duplicated, ...big });
    await publish({ ...base(), transactionId: duplicated, ...big }); // reentrega
    for (const t of harmless) await publish({ ...base(), transactionId: t, amount: { minorUnits: 100, currency: 'BRL' }, counterparty: undefined });
    for (const t of reversed) await publish({ ...base(), transactionId: t, eventType: 'TRANSACTION_REVERSED', ...big });
    await publish({ ...base(), transactionId: invalid[0], amount: { minorUnits: -1, currency: 'BRL' } });
    await publish(`{"transactionId":"${invalid[1]}"`);

    // canal do cliente fora apenas para o alerta "dead"
    await eventually(async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries d JOIN alerts a USING (alert_id) WHERE a.transaction_id = ANY($1) AND d.status = $2', [[...suspiciousOk, duplicated], 'DELIVERED']);
      return rows[0].n === (suspiciousOk.length + 1) * 2;
    });
    faults.customer = true;
    await publish({ ...base(), transactionId: suspiciousDead[0], ...big });
    await eventually(async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries d JOIN alerts a USING (alert_id) WHERE a.transaction_id = $1 AND d.status IN ($2,$3)', [suspiciousDead[0], 'DELIVERED', 'DEAD_LETTERED']);
      return rows[0].n === 2;
    });
    faults.customer = false;
    for (let i = 0; i < 40 && !(await inputEmpty()); i++) await sleep(250);
    expect(await inputEmpty()).toBe(true);

    // 1) estado final de cada evento de entrada
    const alerts = (await pool.query('SELECT transaction_id, alert_id FROM alerts WHERE transaction_id = ANY($1)', [ids])).rows;
    const alertByTx = new Map<string, string[]>();
    for (const a of alerts) alertByTx.set(a.transaction_id, [...(alertByTx.get(a.transaction_id) ?? []), a.alert_id]);

    const inputDlq = await drain(sqs, 'transactions-dlq', (b) => JSON.stringify(b).includes(`tx-loss-${runId}`) || Buffer.from(String((b.original as { payload?: unknown })?.payload ?? ''), 'base64').toString().includes(`tx-loss-${runId}`), { wantAtLeast: invalid.length, rounds: 8 });
    const dlqText = inputDlq.map((m) => {
      const o = m.original as { encoding: string; payload: unknown };
      return o.encoding === 'base64' ? Buffer.from(o.payload as string, 'base64').toString('utf8') : JSON.stringify(o.payload);
    });

    const stateOf = (t: string) => {
      const states: string[] = [];
      if (alertByTx.has(t)) states.push('ALERT');
      if (dlqText.some((txt) => txt.includes(t))) states.push('DLQ');
      if (states.length === 0) states.push('NO_ALERT');
      return states;
    };
    for (const t of [...suspiciousOk, ...suspiciousDead, duplicated]) expect({ t, s: stateOf(t) }).toEqual({ t, s: ['ALERT'] });
    for (const t of [...harmless, ...reversed]) expect({ t, s: stateOf(t) }).toEqual({ t, s: ['NO_ALERT'] });
    for (const t of invalid) expect({ t, s: stateOf(t) }).toEqual({ t, s: ['DLQ'] });
    expect(alertByTx.get(duplicated)).toHaveLength(1);
    expect(inputDlq).toHaveLength(invalid.length); // nada além dos inválidos (sem duplicatas na DLQ)

    // 2) toda entrega de todo alerta termina em DELIVERED ou DLQ do canal (e só nesse estado)
    const deadLetters = new Map<string, Record<string, unknown>[]>();
    for (const [channel, queue] of Object.entries(CH_DLQ)) {
      deadLetters.set(channel, await drain(sqs, queue, (b) => ids.some((t) => alertByTx.get(t)?.includes((b.correlation as { alertId?: string })?.alertId ?? '')), { rounds: 4 }));
    }
    for (const t of [...suspiciousOk, ...suspiciousDead, duplicated]) {
      const alertId = alertByTx.get(t)![0];
      for (const channel of ['ANTIFRAUD_QUEUE', 'PUSH'] as const) {
        const { rows } = await pool.query('SELECT status FROM deliveries WHERE delivery_id = $1', [deliveryIdOf(alertId, channel)]);
        expect(rows).toHaveLength(1);
        const inDlq = (deadLetters.get(channel) ?? []).filter((m) => (m.correlation as { alertId: string }).alertId === alertId).length;
        if (rows[0].status === 'DELIVERED') expect(inDlq).toBe(0);
        else {
          expect(rows[0].status).toBe('DEAD_LETTERED');
          expect(inDlq).toBe(1);
        }
      }
    }
    const pushState = (t: string) => pool.query('SELECT status FROM deliveries WHERE delivery_id = $1', [deliveryIdOf(alertByTx.get(t)![0], 'PUSH')]).then((r) => r.rows[0].status);
    expect(await pushState(suspiciousDead[0])).toBe('DEAD_LETTERED');
    expect(await pushState(suspiciousOk[0])).toBe('DELIVERED');

    // 3) nenhuma entrega fica pendente e nenhum outbox fica sem publicar
    const pending = await pool.query(
      `SELECT (SELECT count(*)::int FROM deliveries d JOIN alerts a USING (alert_id) WHERE a.transaction_id = ANY($1) AND d.status = 'PENDING') AS deliveries,
              (SELECT count(*)::int FROM outbox o JOIN alerts a USING (alert_id) WHERE a.transaction_id = ANY($1) AND o.published_at IS NULL) AS outbox`,
      [ids],
    );
    expect(pending.rows[0]).toEqual({ deliveries: 0, outbox: 0 });
  });
});
