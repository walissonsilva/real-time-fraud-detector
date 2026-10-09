import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
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

describe('rejeição de eventos inválidos ponta a ponta (requer `npm run infra:up` e `npm run migrate`)', () => {
  const runId = randomUUID().slice(0, 8);
  const sqs = newSqs();
  let pool: Pool;
  let app: INestApplication;
  let queueUrl: string;
  const transactionIds: string[] = [];

  const send = async (patch: Record<string, unknown>, raw?: string) => {
    const event = {
      ...readExample('transaction-event.authorized.valid.json'),
      eventId: randomUUID(),
      transactionId: `tx-e2e-inv-${runId}-${randomUUID().slice(0, 8)}`,
      accountId: `acc-e2e-inv-${runId}`,
      ...patch,
    };
    transactionIds.push(event.transactionId);
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: raw ?? JSON.stringify(event) }));
    return event;
  };

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
    process.env.CHANNEL_CONSUMERS_ENABLED = 'false'; // o teste lê as filas de canal diretamente
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'transactions' }))).QueueUrl!;
    await purge(sqs, ['transactions', 'transactions-dlq', ...CHANNEL_QUEUES]);
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

  it('inválidos não bloqueiam válidos: válido suspeito gera alerta e inválidos vão à DLQ', async () => {
    const bad1 = await send({ amount: { minorUnits: -1, currency: 'BRL' } });
    const good = await send({ amount: { minorUnits: 2_000_000, currency: 'BRL' } });
    const bad2 = await send({}, '{"transactionId": "truncado"');
    const bad3 = await send({ schemaVersion: '2.0' });
    const harmless = await send({ amount: { minorUnits: 100, currency: 'BRL' }, counterparty: undefined });

    const row = await eventually(async () => {
      const { rows } = await pool.query('SELECT published_at FROM alerts WHERE transaction_id = $1', [good.transactionId]);
      return rows[0]?.published_at ? rows[0] : undefined;
    });
    expect(row).toBeDefined();

    const dlq = await drain(sqs, 'transactions-dlq', (b) => b.stage === 'INGEST_VALIDATION', { wantAtLeast: 3, rounds: 15 });
    expect(dlq).toHaveLength(3);
    expect(dlq.map((m) => m.reasonCode).sort()).toEqual(['DESERIALIZATION_ERROR', 'SCHEMA_INVALID', 'UNSUPPORTED_VERSION']);

    await eventually(inputEmpty);
    for (const tx of [bad1, bad2, bad3, harmless]) {
      const { rows } = await pool.query('SELECT 1 FROM alerts WHERE transaction_id = $1', [tx.transactionId]);
      expect(rows).toHaveLength(0);
    }
  }, 60_000);
});
