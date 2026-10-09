import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { ConfigModule } from '../src/config/config.module';
import { RulesModule } from '../src/rules/rules.module';
import { CHANNEL_QUEUES, drain, newSqs, purge, readExample } from './integration/support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condição não satisfeita a tempo');
    await sleep(250);
  }
}

describe('processamento ponta a ponta: SQS → regras → outbox → SNS → canais (requer `npm run infra:up` e `npm run migrate`)', () => {
  const runId = randomUUID().slice(0, 8);
  const sqs = newSqs();
  let pool: Pool;
  let app: INestApplication;
  let queueUrl: string;
  const transactionIds: string[] = [];

  const send = async (patch: Record<string, unknown>) => {
    const event = {
      ...readExample('transaction-event.authorized.valid.json'),
      eventId: randomUUID(),
      transactionId: `tx-e2e-${runId}-${randomUUID().slice(0, 8)}`,
      accountId: `acc-e2e-${runId}`,
      ...patch,
    };
    transactionIds.push(event.transactionId);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event),
        MessageAttributes: { traceparent: { DataType: 'String', StringValue: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } },
      }),
    );
    return event;
  };

  const alertRow = async (transactionId: string) =>
    (await pool.query('SELECT alert_id, published_at, score, severity FROM alerts WHERE transaction_id = $1', [transactionId])).rows[0];

  const queueEmpty = async () => {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return Attributes!.ApproximateNumberOfMessages === '0' && Attributes!.ApproximateNumberOfMessagesNotVisible === '0';
  };

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://fraud:fraud@localhost:55432/fraud';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.RULES_CONFIG_PATH = 'config/rules.json';
    process.env.CHANNEL_CONSUMERS_ENABLED = 'false'; // o teste lê as filas de canal diretamente
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'transactions' }))).QueueUrl!;
    await purge(sqs, ['transactions', ...CHANNEL_QUEUES]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pool.query('DELETE FROM outbox WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id = ANY($1))', [transactionIds]);
    await pool.query('DELETE FROM alerts WHERE transaction_id = ANY($1)', [transactionIds]);
    await pool.end();
    sqs.destroy();
  });

  it('cenário 1: evento suspeito gera 1 alerta publicado nos dois canais e sai da fila', async () => {
    const event = await send({ amount: { minorUnits: 2_000_000, currency: 'BRL' } });

    const row = await eventually(async () => {
      const r = await alertRow(event.transactionId);
      return r?.published_at ? r : undefined;
    });
    expect(row.severity).toBe('HIGH');
    expect(row.score).toBe(65);

    for (const queue of CHANNEL_QUEUES) {
      const msgs = await drain(sqs, queue, (b) => b.transactionId === event.transactionId);
      expect(msgs).toHaveLength(1);
      expect((msgs[0].triggeredRules as { ruleId: string }[]).map((r) => r.ruleId).sort()).toEqual([
        'high-amount',
        'high-value-new-counterparty',
      ]);
    }
  });

  it('cenário 2: evento sem suspeita não gera alerta e é removido da fila', async () => {
    const event = await send({ amount: { minorUnits: 100, currency: 'BRL' }, counterparty: undefined });
    await sleep(500);
    await eventually(queueEmpty);
    expect(await alertRow(event.transactionId)).toBeUndefined();
  });

  it('estorno é concluído sem alerta', async () => {
    const event = await send({ eventType: 'TRANSACTION_REVERSED', amount: { minorUnits: 5_000_000, currency: 'BRL' } });
    await sleep(500);
    await eventually(queueEmpty);
    expect(await alertRow(event.transactionId)).toBeUndefined();
  });

  it('o mesmo evento enviado duas vezes gera exatamente 1 alerta', async () => {
    const event = await send({ amount: { minorUnits: 3_000_000, currency: 'BRL' } });
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ ...event, eventId: randomUUID() }) }));
    await eventually(async () => (await alertRow(event.transactionId))?.published_at);
    await eventually(queueEmpty);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM alerts WHERE transaction_id = $1', [event.transactionId]);
    expect(rows[0].n).toBe(1);
  });

  it('FR-014b: configuração de regras inválida impede a aplicação de iniciar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-e2e-'));
    const bad = join(dir, 'rules.json');
    writeFileSync(bad, JSON.stringify({ rules: [readExample('../examples/rule.windowed.valid.json')] }));
    const previous = process.env.RULES_CONFIG_PATH;
    process.env.RULES_CONFIG_PATH = bad;
    try {
      await expect(
        Test.createTestingModule({ imports: [ConfigModule, RulesModule] }).compile(),
      ).rejects.toThrow(/Configuração de regras inválida/);
    } finally {
      process.env.RULES_CONFIG_PATH = previous;
    }
  });
});
