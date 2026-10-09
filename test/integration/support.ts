import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { FraudAlert } from '../../src/alerts/fraud-alert';
import { dedupeKeyOf } from '../../src/alerts/dedupe-key';
import { IngestedEvent, TransactionEvent } from '../../src/transactions/transaction-event';

const contracts = join(__dirname, '../../docs/contratos');
export const readExample = (rel: string) => JSON.parse(readFileSync(join(contracts, 'examples', rel), 'utf8'));

export const CHANNEL_QUEUES = ['alert-deliveries-antifraud-queue.fifo', 'alert-deliveries-customer-push.fifo'];

export function newPool() {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

export function newSqs() {
  return new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });
}

/** Evento suspeito (valor alto) único por execução, com conta própria para isolar grupos FIFO. */
export function suspiciousEvent(runId: string, patch: Record<string, unknown> = {}): TransactionEvent {
  return {
    ...readExample('transaction-event.authorized.valid.json'),
    eventId: randomUUID(),
    transactionId: `tx-int-${runId}-${randomUUID().slice(0, 8)}`,
    accountId: `acc-int-${runId}`,
    amount: { minorUnits: 2_000_000, currency: 'BRL' },
    ...patch,
  } as TransactionEvent;
}

export function ingested(event: TransactionEvent): IngestedEvent {
  const now = Date.now();
  return {
    event,
    ingestedAt: new Date(now - 30),
    consumedAt: new Date(now - 10),
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };
}

export function pendingAlert(runId: string): FraudAlert {
  const transactionId = `tx-int-${runId}-${randomUUID().slice(0, 8)}`;
  const base = readExample('fraud-alert.valid.json');
  const { publishedAt: _p, latencyMs: _l, ...rest } = base;
  return { ...rest, alertId: randomUUID(), transactionId, dedupeKey: dedupeKeyOf(transactionId), accountId: `acc-int-${runId}` } as FraudAlert;
}

export async function purge(sqs: SQSClient, names: string[]) {
  for (const QueueName of names) {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName }));
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
  }
}

/** Lê a fila e devolve as mensagens cujo corpo satisfaz `match`; as demais voltam imediatamente. */
export async function drain(
  sqs: SQSClient,
  queueName: string,
  match: (body: Record<string, unknown>) => boolean,
  { wantAtLeast = 1, rounds = 6 }: { wantAtLeast?: number; rounds?: number } = {},
): Promise<Record<string, unknown>[]> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  const found: Record<string, unknown>[] = [];
  for (let i = 0; i < rounds; i++) {
    const res = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
    );
    for (const m of res.Messages ?? []) {
      const body = JSON.parse(m.Body!);
      if (match(body)) {
        found.push(body);
        await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle! }));
      } else {
        await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: 0 }));
      }
    }
    if (found.length >= wantAtLeast && i >= 1) break;
  }
  return found;
}
