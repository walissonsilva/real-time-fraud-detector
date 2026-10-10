/**
 * Teste de carga k6: latência ponta a ponta do envio do evento à fila `transactions` até o alerta
 * chegar a uma assinante do tópico SNS `alerts.fifo`. Roda contra o LocalStack (AWS_ENDPOINT definido,
 * `npm run load:k6`) ou contra a AWS real, em uma task Fargate na VPC (`infra/terraform/scripts/loadtest.sh`).
 *
 * - `producer`: taxa de eventos (RATE/s, um SendMessage por evento) na fila SQS, com aquecimento opcional
 *   (WARMUP_SECONDS) até a taxa-alvo; só ALERT_RATE deles são suspeitos.
 * - `consumer`: lê uma fila FIFO assinante do tópico (criada pelo `setup()` no LocalStack ou pelo
 *   loadtest.sh na AWS, via SINK_QUEUE_URL) e calcula latência = recebimento do alerta -
 *   `transactionOccurredAt` (que o produtor carimba com o instante do envio). Também conta duplicados.
 * - As requisições são assinadas com SigV4 (vendor/aws-signature). As credenciais vêm da task role
 *   (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) ou de AWS_ACCESS_KEY_ID/SECRET (LocalStack: test/test).
 * - Percentis e thresholds de latência valem só para a fase `steady` (após o aquecimento).
 * - RESULTS_MODE=file grava .txt/.json/.html em RESULTS_DIR; RESULTS_MODE=stdout (AWS) imprime os mesmos
 *   arquivos em base64 no stdout, em linhas `K6ART|nome|i|n|dados`, que o loadtest.sh remonta a partir do CloudWatch Logs.
 *
 * Ver docs/teste-de-carga-aws-1000tps.md e load/k6/README.md.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { uuidv4 } from './vendor/k6-utils-1.4.0.js';
import { htmlReport } from './vendor/k6-reporter-3.0.1.js';
import { textSummary } from './vendor/k6-summary-0.0.2.js';
import { Endpoint, SignatureV4 } from './vendor/aws-signature-0.12.3.js';

const LOCAL_ENDPOINT = __ENV.AWS_ENDPOINT || '';
const REGION = __ENV.AWS_REGION || 'us-east-1';
const QUEUE_NAME = __ENV.SQS_TRANSACTIONS_QUEUE || 'transactions';
const TOPIC_NAME = __ENV.SNS_ALERTS_TOPIC || 'alerts.fifo';
const TOPIC_ARN = __ENV.SNS_ALERTS_TOPIC_ARN || `arn:aws:sns:${REGION}:000000000000:${TOPIC_NAME}`;
const SINK_NAME = __ENV.SINK_QUEUE_NAME || 'alerts-loadtest.fifo';
const SINK_QUEUE_URL = __ENV.SINK_QUEUE_URL || ''; // definido na AWS: o sink é criado pelo loadtest.sh
const SQS_ENDPOINT = new Endpoint(LOCAL_ENDPOINT || `https://sqs.${REGION}.amazonaws.com`);
const SNS_ENDPOINT = new Endpoint(LOCAL_ENDPOINT || `https://sns.${REGION}.amazonaws.com`);

const RATE = Number(__ENV.RATE || 100);
const DURATION_S = Number(__ENV.DURATION_SECONDS || 600);
const WARMUP_S = Number(__ENV.WARMUP_SECONDS || 0);
const WARMUP_START_RATE = Math.min(RATE, Number(__ENV.WARMUP_START_RATE || 200));
const DRAIN_S = Number(__ENV.DRAIN_SECONDS || 30);
const ALERT_RATE = Number(__ENV.ALERT_RATE || 0.01);
const ACCOUNTS = Number(__ENV.ACCOUNTS || 500);
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(200, Math.ceil(RATE / 2)));
const P95_MS = Number(__ENV.P95_MS || 500);
const P99_MS = Number(__ENV.P99_MS || 500);
const RESULTS_MODE = __ENV.RESULTS_MODE || 'file';
const CHUNK_CHARS = 100000; // abaixo do limite de 256 KB por evento do CloudWatch Logs

const eventsSent = new Counter('events_sent');
const alertsExpected = new Counter('alerts_expected');
const alertsReceived = new Counter('alerts_received');
const alertsDuplicated = new Counter('alerts_duplicated');
const sendErrors = new Rate('send_errors');
const sendLatency = new Trend('send_latency_ms', true);
const e2eLatency = new Trend('alert_e2e_latency_ms', true);
const serviceLatency = new Trend('alert_service_latency_ms', true);

const stages = [];
if (WARMUP_S > 0) stages.push({ duration: `${WARMUP_S}s`, target: RATE });
stages.push({ duration: `${DURATION_S}s`, target: RATE });

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    producer: {
      executor: 'ramping-arrival-rate',
      startRate: WARMUP_S > 0 ? WARMUP_START_RATE : RATE,
      timeUnit: '1s',
      stages,
      preAllocatedVUs: Math.min(MAX_VUS, Math.max(20, Math.ceil(RATE / 10))),
      maxVUs: MAX_VUS,
      exec: 'produce',
    },
    // Um único consumidor: a contagem de duplicados usa a memória do VU.
    consumer: {
      executor: 'constant-vus',
      vus: 1,
      duration: `${WARMUP_S + DURATION_S + DRAIN_S}s`,
      exec: 'consume',
    },
  },
  thresholds: {
    'alert_e2e_latency_ms{phase:steady}': [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
    'alert_service_latency_ms{phase:steady}': [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
    send_errors: ['rate<0.001'],
    alerts_duplicated: ['count==0'],
    dropped_iterations: ['count==0'],
  },
};

// --- AWS (SigV4) ------------------------------------------------------------------------------

function credentials() {
  const rel = __ENV.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (rel) {
    const res = http.get(`http://169.254.170.2${rel}`);
    if (res.status !== 200) throw new Error(`credenciais da task role indisponíveis: ${res.status} ${res.body}`);
    const c = res.json();
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token };
  }
  return {
    accessKeyId: __ENV.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: __ENV.AWS_SECRET_ACCESS_KEY || 'test',
    sessionToken: __ENV.AWS_SESSION_TOKEN || undefined,
  };
}

const signers = {}; // um signer por serviço em cada VU
function signer(service, creds) {
  if (!signers[service]) signers[service] = new SignatureV4({ service, region: REGION, credentials: creds, uriEscapePath: false, applyChecksum: false });
  return signers[service];
}

function sqs(creds, action, body) {
  const req = signer('sqs', creds).sign({
    method: 'POST',
    endpoint: SQS_ENDPOINT,
    path: '/',
    headers: { 'Content-Type': 'application/x-amz-json-1.0', 'X-Amz-Target': `AmazonSQS.${action}` },
    body: JSON.stringify(body),
  });
  return http.post(req.url, req.body, { headers: req.headers, tags: { aws_action: action } });
}

function sns(creds, params) {
  const body = Object.keys({ Version: '2010-03-31', ...params })
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(({ Version: '2010-03-31', ...params })[k])}`)
    .join('&');
  const req = signer('sns', creds).sign({
    method: 'POST',
    endpoint: SNS_ENDPOINT,
    path: '/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return http.post(req.url, req.body, { headers: req.headers, tags: { aws_action: params.Action } });
}

// --- geração de eventos (contrato docs/contratos/transaction-event.v1.schema.json) -------------

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

// Valor legítimo: lognormal com mediana ~R$ 90, limitado a < R$ 5.000 (abaixo dos limiares de config/rules.json).
function legitAmountMinor() {
  const reais = Math.exp(4.5 + 1.2 * gaussian());
  return Math.min(499_900, Math.max(100, Math.round(reais * 100)));
}

// Cada receita aciona ao menos uma regra de config/rules.json.
const SUSPECT_RECIPES = [
  { weight: 50, build: (e) => { e.amount.minorUnits = 1_000_000 + Math.floor(Math.random() * 4_000_000); } }, // high-amount
  {
    weight: 20, // high-value-new-counterparty (sem firstSeenAt)
    build: (e) => {
      e.amount.minorUnits = 500_000 + Math.floor(Math.random() * 400_000);
      e.counterparty = { idToken: `cpt_${uuidv4().slice(0, 8)}`, institutionCode: '60701190' };
    },
  },
  {
    weight: 20, // risky-merchant-country
    build: (e) => {
      e.transactionType = 'CARD_PURCHASE';
      e.channel = 'POS';
      e.merchant = { id: `mch_${Math.floor(Math.random() * 1000)}`, mcc: '5411', country: pick(['KP', 'IR', 'SY', 'CU']) };
    },
  },
  {
    weight: 10, // unusual-channel-transaction-type
    build: (e) => {
      e.channel = pick(['ATM', 'POS']);
      e.transactionType = pick(['PIX', 'BOLETO']);
    },
  },
];

function pickRecipe() {
  let r = Math.random() * SUSPECT_RECIPES.reduce((s, x) => s + x.weight, 0);
  for (const recipe of SUSPECT_RECIPES) {
    r -= recipe.weight;
    if (r <= 0) return recipe;
  }
  return SUSPECT_RECIPES[0];
}

function buildEvent(runId, suspect) {
  const n = Math.floor(Math.random() * ACCOUNTS);
  const event = {
    schemaVersion: '1.0',
    eventId: uuidv4(),
    transactionId: `k6-${runId}-${exec.scenario.iterationInTest}`,
    eventType: 'TRANSACTION_AUTHORIZED',
    occurredAt: new Date().toISOString(), // reaparece em transactionOccurredAt: base da latência
    producer: 'k6-load',
    transactionType: pick(['PIX', 'PIX', 'TED', 'CARD_PURCHASE', 'TRANSFER_INTERNAL']),
    channel: pick(['MOBILE_APP', 'MOBILE_APP', 'WEB']),
    amount: { minorUnits: legitAmountMinor(), currency: 'BRL' },
    customerId: `cus_k6_${n}`,
    accountId: `acc_k6_${n}`, // muitas contas: o SNS FIFO serializa por accountId (MessageGroupId)
  };
  if (suspect) pickRecipe().build(event);
  return event;
}

// --- ciclo de vida -----------------------------------------------------------------------------

export function setup() {
  const runId = __ENV.RUN_ID || uuidv4().slice(0, 8);
  const creds = credentials();

  const tx = sqs(creds, 'GetQueueUrl', { QueueName: QUEUE_NAME });
  if (tx.status !== 200) throw new Error(`GetQueueUrl(${QUEUE_NAME}) falhou: ${tx.status} ${tx.body}`);
  const txUrl = tx.json('QueueUrl');

  let sinkUrl = SINK_QUEUE_URL;
  let subscriptionArn = '';
  if (!sinkUrl) {
    // LocalStack: fila assinante dedicada, criada e removida pelo próprio teste
    const created = sqs(creds, 'CreateQueue', {
      QueueName: SINK_NAME,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' },
    });
    if (created.status !== 200) throw new Error(`CreateQueue falhou: ${created.status} ${created.body}`);
    sinkUrl = created.json('QueueUrl');
    sqs(creds, 'PurgeQueue', { QueueUrl: sinkUrl });

    const sub = sns(creds, {
      Action: 'Subscribe',
      TopicArn: TOPIC_ARN,
      Protocol: 'sqs',
      Endpoint: `arn:aws:sqs:${REGION}:000000000000:${SINK_NAME}`,
      'Attributes.entry.1.key': 'RawMessageDelivery',
      'Attributes.entry.1.value': 'true',
      ReturnSubscriptionArn: 'true',
    });
    const match = /<SubscriptionArn>([^<]+)<\/SubscriptionArn>/.exec(sub.body || '');
    if (sub.status !== 200 || !match) throw new Error(`Subscribe falhou: ${sub.status} ${sub.body}`);
    subscriptionArn = match[1];
  }

  return { runId, creds, txUrl, sinkUrl, subscriptionArn, startedAt: Date.now() };
}

export function produce(data) {
  const suspect = Math.random() < ALERT_RATE;
  const event = buildEvent(data.runId, suspect);
  const res = sqs(data.creds, 'SendMessage', { QueueUrl: data.txUrl, MessageBody: JSON.stringify(event) });
  const ok = check(res, { 'SendMessage 200': (r) => r.status === 200 });
  sendErrors.add(!ok);
  if (ok) {
    sendLatency.add(res.timings.duration);
    eventsSent.add(1);
    if (suspect) alertsExpected.add(1);
  } else if (exec.scenario.iterationInTest % 100 === 0) {
    console.error(`SendMessage falhou: ${res.status} ${String(res.body).slice(0, 200)}`);
  }
}

const seen = new Set(); // transactionIds já recebidos (único consumidor)

export function consume(data) {
  const res = sqs(data.creds, 'ReceiveMessage', {
    QueueUrl: data.sinkUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  });
  if (res.status !== 200) {
    sleep(0.5);
    return;
  }
  const now = Date.now();
  const messages = res.json('Messages') || [];
  const prefix = `k6-${data.runId}-`;
  const steadyFrom = data.startedAt + WARMUP_S * 1000;
  const handles = [];
  messages.forEach((m, i) => {
    handles.push({ Id: String(i), ReceiptHandle: m.ReceiptHandle });
    let alert;
    try {
      alert = JSON.parse(m.Body);
    } catch {
      return;
    }
    if (!alert.transactionId || !alert.transactionId.startsWith(prefix)) return; // resíduo de outra execução
    if (seen.has(alert.transactionId)) {
      alertsDuplicated.add(1);
      return;
    }
    seen.add(alert.transactionId);
    alertsReceived.add(1);
    const occurredAt = Date.parse(alert.transactionOccurredAt);
    const tags = { phase: occurredAt >= steadyFrom ? 'steady' : 'warmup' };
    e2eLatency.add(now - occurredAt, tags);
    if (typeof alert.latencyMs === 'number') serviceLatency.add(alert.latencyMs, tags);
  });
  if (handles.length) sqs(data.creds, 'DeleteMessageBatch', { QueueUrl: data.sinkUrl, Entries: handles });
}

export function teardown(data) {
  if (!data.subscriptionArn) return; // sink externo: removido pelo loadtest.sh
  sns(data.creds, { Action: 'Unsubscribe', SubscriptionArn: data.subscriptionArn });
  sqs(data.creds, 'DeleteQueue', { QueueUrl: data.sinkUrl });
}

function artifactLines(name, content) {
  const b64 = encoding.b64encode(content);
  const parts = Math.ceil(b64.length / CHUNK_CHARS);
  const lines = [];
  for (let i = 0; i < parts; i++) lines.push(`K6ART|${name}|${i}|${parts}|${b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)}`);
  return lines.join('\n');
}

export function handleSummary(summary) {
  const metric = (name, stat) => (summary.metrics[name] && summary.metrics[name].values ? summary.metrics[name].values[stat] : undefined);
  const count = (name) => metric(name, 'count') || 0;
  const sub = (name) => (summary.metrics[`${name}{phase:steady}`] || {}).values || {};
  const expected = count('alerts_expected');
  const received = count('alerts_received');
  const lost = Math.max(0, expected - received);
  const dropped = count('dropped_iterations');
  const sent = count('events_sent');
  const svc = sub('alert_service_latency_ms');
  const lat = sub('alert_e2e_latency_ms');
  const send = (summary.metrics.send_latency_ms || {}).values || {};
  const fmt = (v) => (v === undefined ? 'n/a' : `${v.toFixed(1)} ms`);
  const text = [
    '',
    '=== Resumo do teste de carga de fraude ===',
    `eventos enviados : ${sent} (alvo ${RATE}/s, taxa de suspeitos ${(ALERT_RATE * 100).toFixed(2)}%, aquecimento ${WARMUP_S}s)`,
    `alertas esperados: ${expected}`,
    `alertas recebidos: ${received}${lost ? ` (FALTAM ${lost})` : ''}`,
    `alertas duplicados: ${count('alerts_duplicated')}`,
    `iter. descartadas: ${dropped}${dropped ? ' (VUs esgotados ou gerador saturado: o alvo não foi cumprido; aumente MAX_VUS/CPU do k6)' : ''}`,
    `envio ao SQS     : p50 ${fmt(send['med'])} | p95 ${fmt(send['p(95)'])} | max ${fmt(send['max'])}`,
    `latência serviço : p50 ${fmt(svc['med'])} | p95 ${fmt(svc['p(95)'])} | p99 ${fmt(svc['p(99)'])} | max ${fmt(svc['max'])}  (fase steady; ingestedAt→publishedAt, relógio do serviço)`,
    `latência e2e (k6): p50 ${fmt(lat['med'])} | p95 ${fmt(lat['p(95)'])} | p99 ${fmt(lat['p(99)'])} | max ${fmt(lat['max'])}  (fase steady)`,
    '',
  ].join('\n');
  const report = textSummary(summary, { indent: ' ', enableColors: false }) + text;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const json = JSON.stringify(summary, null, 2);
  const html = htmlReport(summary);

  if (RESULTS_MODE === 'stdout') {
    const run = __ENV.RUN_ID || stamp;
    return {
      stdout: [report, artifactLines(`${run}.txt`, report), artifactLines(`${run}.json`, json), artifactLines(`${run}.html`, html)].join('\n') + '\n',
    };
  }
  const base = `${__ENV.RESULTS_DIR || '/results'}/${stamp}`;
  return {
    stdout: report,
    [`${base}.txt`]: report,
    [`${base}.json`]: json,
    [`${base}.html`]: html,
  };
}
