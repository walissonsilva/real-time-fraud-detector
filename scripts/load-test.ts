/**
 * Teste de carga leve do caminho de detecção (SC-004: p99 ≤ 500 ms; alvo 8.000 TPS).
 *
 * Requer a aplicação rodando (`npm run start`) com a infraestrutura de pé. Publica `LOAD_TOTAL` eventos
 * suspeitos na fila `transactions` a `LOAD_RATE` eventos/s, espera os alertas serem publicados e imprime
 * a latência de detecção (published_at - ingested_at, ambos gravados pelo próprio serviço) e se houve
 * indício de teto do SNS FIFO (D-06): publicações imediatas que falharam e foram para o relay.
 *
 *   LOAD_TOTAL=2000 LOAD_RATE=500 npm run load
 *
 * Em LocalStack o resultado mede a lógica do serviço, não a capacidade real da AWS; use-o como
 * regressão e para achar gargalos locais. O alvo de 8.000 TPS exige o ambiente de destino.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';

const TOTAL = Number(process.env.LOAD_TOTAL ?? 2000);
const RATE = Number(process.env.LOAD_RATE ?? 500);
const TARGET_P99_MS = 500;
const WAIT_MS = Number(process.env.LOAD_WAIT_MS ?? 120_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const runId = randomUUID().slice(0, 8);
  const sqs = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const queue = process.env.SQS_TRANSACTIONS_QUEUE ?? 'transactions';
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queue }));
  const base = JSON.parse(readFileSync(join(__dirname, '../docs/contratos/examples/transaction-event.authorized.valid.json'), 'utf8'));
  const prefix = `tx-load-${runId}-`;

  // envio em lotes de 10, espaçado para respeitar a taxa pedida
  const startedAt = Date.now();
  let sent = 0;
  while (sent < TOTAL) {
    const n = Math.min(10, TOTAL - sent);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl,
        Entries: Array.from({ length: n }, (_, i) => ({
          Id: String(i),
          MessageBody: JSON.stringify({
            ...base,
            eventId: randomUUID(),
            transactionId: `${prefix}${sent + i}`,
            accountId: `acc-load-${(sent + i) % 500}`,
            amount: { minorUnits: 2_000_000, currency: 'BRL' },
          }),
        })),
      }),
    );
    sent += n;
    const ahead = startedAt + (sent / RATE) * 1000 - Date.now();
    if (ahead > 0) await sleep(ahead);
  }
  const sendSeconds = (Date.now() - startedAt) / 1000;

  const count = async () =>
    (await pool.query('SELECT count(*)::int AS n FROM alerts WHERE transaction_id LIKE $1 AND published_at IS NOT NULL', [`${prefix}%`])).rows[0].n as number;
  const deadline = Date.now() + WAIT_MS;
  let done = await count();
  while (done < TOTAL && Date.now() < deadline) {
    await sleep(500);
    done = await count();
  }
  const totalSeconds = (Date.now() - startedAt) / 1000;

  const { rows } = await pool.query(
    `SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY ms) AS p50,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99,
            max(ms) AS max
       FROM (SELECT extract(epoch FROM (a.published_at - a.ingested_at)) * 1000 AS ms
               FROM alerts a WHERE a.transaction_id LIKE $1 AND a.published_at IS NOT NULL) t`,
    [`${prefix}%`],
  );
  const throttled = (
    await pool.query(
      `SELECT count(*)::int AS n FROM outbox o JOIN alerts a USING (alert_id)
        WHERE a.transaction_id LIKE $1 AND o.attempts > 0`,
      [`${prefix}%`],
    )
  ).rows[0].n as number;
  const pending = (
    await pool.query(
      `SELECT count(*)::int AS n FROM outbox o JOIN alerts a USING (alert_id) WHERE a.transaction_id LIKE $1 AND o.published_at IS NULL`,
      [`${prefix}%`],
    )
  ).rows[0].n as number;

  if (process.env.LOAD_DEBUG) {
    const slow = await pool.query(
      `SELECT a.alert_id, split_part(a.transaction_id,'-',4) AS n, a.ingested_at, a.detected_at, o.created_at AS db_created, a.published_at, now() AS db_now,
              extract(epoch FROM (a.detected_at - a.ingested_at)) * 1000 AS detect_ms,
              extract(epoch FROM (a.published_at - a.detected_at)) * 1000 AS publish_ms, o.attempts
         FROM alerts a JOIN outbox o USING (alert_id) WHERE a.transaction_id LIKE $1 ORDER BY a.published_at - a.ingested_at DESC LIMIT 8`,
      [`${prefix}%`],
    );
    console.log(slow.rows);
  }
  const p99 = Number(rows[0].p99);
  console.log(
    JSON.stringify(
      {
        sent: TOTAL,
        publishedAlerts: done,
        requestedRateTps: RATE,
        achievedSendTps: Math.round(TOTAL / sendSeconds),
        endToEndTps: Math.round(done / totalSeconds),
        latencyMs: { p50: Math.round(Number(rows[0].p50)), p99: Math.round(p99), max: Math.round(Number(rows[0].max)) },
        targetP99Ms: TARGET_P99_MS,
        p99WithinTarget: p99 <= TARGET_P99_MS,
        publishFailuresSentToRelay: throttled, // D-06: > 0 sugere teto do SNS FIFO atingido
        stillPendingInOutbox: pending,
      },
      null,
      2,
    ),
  );

  // as entregas aos canais são assíncronas: espera terminarem antes de limpar (a FK de deliveries exige)
  const openDeliveries = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM deliveries d JOIN alerts a USING (alert_id) WHERE a.transaction_id LIKE $1 AND d.status = 'PENDING')
              + ($2::int * 2 - (SELECT count(*)::int FROM deliveries d JOIN alerts a USING (alert_id) WHERE a.transaction_id LIKE $1)) AS n`,
        [`${prefix}%`, done],
      )
    ).rows[0].n as number;
  const channelDeadline = Date.now() + 60_000;
  while ((await openDeliveries()) > 0 && Date.now() < channelDeadline) await sleep(500);

  // limpeza
  await pool.query('DELETE FROM deliveries WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id LIKE $1)', [`${prefix}%`]);
  await pool.query('DELETE FROM outbox WHERE alert_id IN (SELECT alert_id FROM alerts WHERE transaction_id LIKE $1)', [`${prefix}%`]);
  await pool.query('DELETE FROM alerts WHERE transaction_id LIKE $1', [`${prefix}%`]);
  await pool.end();
  sqs.destroy();
  if (done < TOTAL) process.exitCode = 2;
  else if (p99 > TARGET_P99_MS) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
