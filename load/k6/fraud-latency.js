/**
 * Teste de carga k6: latência ponta a ponta do envio do evento à fila `transactions` até o alerta
 * chegar a uma assinante do tópico SNS `alerts.fifo`.
 *
 * - `producer`: taxa constante de eventos (RATE/s) na fila SQS; só ALERT_RATE deles são suspeitos.
 * - `consumer`: lê uma fila FIFO dedicada, criada e assinada no `setup()`, e calcula
 *   latência = recebimento do alerta - `transactionOccurredAt` (que o produtor carimba com o
 *   instante do envio; o serviço devolve o valor no alerta).
 *
 * Fala direto com a Query/JSON API do LocalStack (sem SigV4, sem extensões do k6). Contra AWS real seria
 * necessário assinar as requisições. Uso: `npm run load:k6` (ver load/k6/README.md).
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/3.0.1/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const ENDPOINT = __ENV.AWS_ENDPOINT || 'http://localhost:4566';
const REGION = __ENV.AWS_REGION || 'us-east-1';
const ACCOUNT = '000000000000';
const QUEUE_NAME = __ENV.SQS_TRANSACTIONS_QUEUE || 'transactions';
const TOPIC_NAME = __ENV.SNS_ALERTS_TOPIC || 'alerts.fifo';
const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:${TOPIC_NAME}`;
const SINK_NAME = 'alerts-loadtest.fifo';

const RATE = Number(__ENV.RATE || 100);
const DURATION_S = Number(__ENV.DURATION_SECONDS || 600);
const DRAIN_S = Number(__ENV.DRAIN_SECONDS || 30);
const ALERT_RATE = Number(__ENV.ALERT_RATE || 0.01);
const ACCOUNTS = Number(__ENV.ACCOUNTS || 500);
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(100, RATE * 2));
const P95_MS = Number(__ENV.P95_MS || 500);
const P99_MS = Number(__ENV.P99_MS || 1000);

const eventsSent = new Counter('events_sent');
const alertsExpected = new Counter('alerts_expected');
const alertsReceived = new Counter('alerts_received');
const sendErrors = new Rate('send_errors');
const e2eLatency = new Trend('alert_e2e_latency_ms', true);
const serviceLatency = new Trend('alert_service_latency_ms', true);

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    producer: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: Math.max(20, Math.ceil(RATE / 2)),
      maxVUs: MAX_VUS,
      exec: 'produce',
    },
    consumer: {
      executor: 'constant-vus',
      vus: 2,
      duration: `${DURATION_S + DRAIN_S}s`,
      exec: 'consume',
    },
  },
  thresholds: {
    alert_e2e_latency_ms: [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
    alert_service_latency_ms: [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
    send_errors: ['rate<0.001'],
  },
};

// --- AWS (LocalStack) -------------------------------------------------------------------------

const AUTH = (service) =>
  `AWS4-HMAC-SHA256 Credential=test/20260101/${REGION}/${service}/aws4_request, SignedHeaders=host, Signature=x`;

function sqs(action, body) {
  return http.post(`${ENDPOINT}/`, JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': `AmazonSQS.${action}`,
      Authorization: AUTH('sqs'),
    },
    tags: { aws_action: action },
  });
}

function sns(params) {
  return http.post(`${ENDPOINT}/`, { Version: '2010-03-31', ...params }, {
    headers: { Authorization: AUTH('sns') },
    tags: { aws_action: params.Action },
  });
}

const queueUrl = (name) => `${ENDPOINT}/${ACCOUNT}/${name}`;

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
  const runId = uuidv4().slice(0, 8);
  const sinkUrl = queueUrl(SINK_NAME);

  // fila assinante dedicada: não interfere nas filas de canal consumidas pelo app
  const created = sqs('CreateQueue', {
    QueueName: SINK_NAME,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' },
  });
  if (created.status !== 200) throw new Error(`CreateQueue falhou: ${created.status} ${created.body}`);
  sqs('PurgeQueue', { QueueUrl: sinkUrl });

  const sinkArn = `arn:aws:sqs:${REGION}:${ACCOUNT}:${SINK_NAME}`;
  const sub = sns({
    Action: 'Subscribe',
    TopicArn: TOPIC_ARN,
    Protocol: 'sqs',
    Endpoint: sinkArn,
    'Attributes.entry.1.key': 'RawMessageDelivery',
    'Attributes.entry.1.value': 'true',
    ReturnSubscriptionArn: 'true',
  });
  const match = /<SubscriptionArn>([^<]+)<\/SubscriptionArn>/.exec(sub.body || '');
  if (sub.status !== 200 || !match) throw new Error(`Subscribe falhou: ${sub.status} ${sub.body}`);

  return { runId, sinkUrl, subscriptionArn: match[1], startedAt: Date.now() };
}

export function produce(data) {
  const suspect = Math.random() < ALERT_RATE;
  const event = buildEvent(data.runId, suspect);
  const res = sqs('SendMessage', { QueueUrl: queueUrl(QUEUE_NAME), MessageBody: JSON.stringify(event) });
  const ok = check(res, { 'SendMessage 200': (r) => r.status === 200 });
  sendErrors.add(!ok);
  if (ok) {
    eventsSent.add(1);
    if (suspect) alertsExpected.add(1);
  }
}

export function consume(data) {
  const res = sqs('ReceiveMessage', {
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
  const handles = [];
  messages.forEach((m, i) => {
    handles.push({ Id: String(i), ReceiptHandle: m.ReceiptHandle });
    let alert;
    try {
      alert = JSON.parse(m.Body);
    } catch (e) {
      return;
    }
    if (!alert.transactionId || !alert.transactionId.startsWith(prefix)) return; // resíduo de outra execução
    alertsReceived.add(1);
    e2eLatency.add(now - Date.parse(alert.transactionOccurredAt));
    if (typeof alert.latencyMs === 'number') serviceLatency.add(alert.latencyMs);
  });
  if (handles.length) sqs('DeleteMessageBatch', { QueueUrl: data.sinkUrl, Entries: handles });
}

export function teardown(data) {
  sns({ Action: 'Unsubscribe', SubscriptionArn: data.subscriptionArn });
  sqs('DeleteQueue', { QueueUrl: data.sinkUrl });
}

export function handleSummary(summary) {
  const count = (name) => (summary.metrics[name] ? summary.metrics[name].values.count : 0);
  const expected = count('alerts_expected');
  const received = count('alerts_received');
  const lost = Math.max(0, expected - received);
  const lat = summary.metrics.alert_e2e_latency_ms ? summary.metrics.alert_e2e_latency_ms.values : {};
  const svc = summary.metrics.alert_service_latency_ms ? summary.metrics.alert_service_latency_ms.values : {};
  const dropped = count('dropped_iterations');
  const fmt = (v) => (v === undefined ? 'n/a' : `${v.toFixed(1)} ms`);
  const text = [
    '',
    '=== Resumo do teste de carga de fraude ===',
    `eventos enviados : ${count('events_sent')} (alvo ${RATE}/s, taxa de suspeitos ${(ALERT_RATE * 100).toFixed(2)}%)`,
    `alertas esperados: ${expected}`,
    `alertas recebidos: ${received}${lost ? ` (FALTAM ${lost})` : ''}`,
    `iter. descartadas: ${dropped}${dropped ? ' (VUs esgotados: aumente MAX_VUS ou o alvo não foi cumprido)' : ''}`,
    `latência serviço : p50 ${fmt(svc['med'])} | p95 ${fmt(svc['p(95)'])} | p99 ${fmt(svc['p(99)'])} | max ${fmt(svc['max'])}  (ingestedAt→publishedAt, relógio do serviço)`,
    `latência e2e (k6): p50 ${fmt(lat['med'])} | p95 ${fmt(lat['p(95)'])} | p99 ${fmt(lat['p(99)'])} | max ${fmt(lat['max'])}`,
    '',
  ].join('\n');
  const report = textSummary(summary, { indent: ' ', enableColors: false }) + text;
  const base = `${__ENV.RESULTS_DIR || '/results'}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return {
    stdout: report,
    [`${base}.txt`]: report,
    [`${base}.json`]: JSON.stringify(summary, null, 2),
    [`${base}.html`]: htmlReport(summary),
  };
}
