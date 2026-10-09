# Real-Time Fraud Detector

Motor de detecção de transações suspeitas em tempo real (CE 1). Decisões e requisitos em [docs/](docs/README.md).

## Estrutura (módulos NestJS)

Um módulo por funcionalidade; cada serviço é `@Injectable()` e injetado pela classe (sem portas/tokens).

```
src/
  transactions/   consumo da fila de transações (SQS), validação (Ajv), ProcessTransactionService, RejectInvalidEventService
  rules/          regras declarativas: DeclarativeRuleEngine, carga/validação de config/rules.json, StaticRuleRepository
  alerts/         FraudAlert, decisão/dedupe, AlertRepository (Postgres + outbox), SnsEventBus, relay do outbox
  deliveries/     entrega por canal: DeliverAlertService, DeliveryRepository, provedores simulados, consumidores SQS
  dlq/            DlqMessage e SqsDlqPublisher
  health/         /health e /metrics
  config/ observability/ database/ aws/ cache/ shared/   infraestrutura transversal (config, logs/métricas, Postgres + migrações, SQS/SNS, Redis, retry)
config/rules.json  regras stateless carregadas na inicialização
scripts/           teste de carga (`npm run load`)
infra/localstack/  criação das filas e tópicos (ADR-01)
```

## Execução local

```bash
npm install
npm run infra:up      # Postgres (porta 55432), Redis, LocalStack (SQS/SNS)
npm run migrate
npm run start:dev     # http://localhost:3000/health/ready
npm test              # unitários
npm run test:e2e      # requer infra:up
npm run infra:down    # remove containers e volumes
```

Configuração em `.env` (copie de `.env.example`; sem segredos reais).

## Como funciona

```
transactions (SQS) ─▶ valida (TransactionEvent v1) ─┬─ inválido ─▶ transactions-dlq (motivo + original, sem PII nos logs)
                                                    └─ válido ─▶ regras stateless ─▶ alerta + outbox (mesma transação Postgres)
                                                                      │ publicação imediata + relay de pendentes
                                                                      ▼
                                               SNS FIFO alerts.fifo (grupo = accountId, dedupe = dedupeKey)
                                   ├─▶ SQS FIFO alert-deliveries-antifraud-queue.fifo ─▶ canal interno ─ falha ─▶ DLQ do canal
                                   └─▶ SQS FIFO alert-deliveries-customer-push.fifo   ─▶ canal cliente ─ falha ─▶ DLQ do canal
```

- **Um alerta por transação**: `dedupeKey = sha256("fraud-alert:v1:" + transactionId)`; reentrega e concorrência não geram segundo alerta.
- **Falha transitória** (banco, avaliação): até 3 retentativas com espera crescente na própria fila; depois `DlqMessage` `MAX_RETRIES_EXCEEDED`.
- **Entrega por canal**: `deliveryId = sha256("alert-delivery:v1:" + alertId + ":" + canal)`, estável entre retentativas; timeout, retry com backoff e jitter, e DLQ por canal (`CHANNEL_DELIVERY`). A mensagem ao cliente só leva tipo, valor formatado, data e a orientação de confirmar/contestar.
- **Observabilidade**: logs JSON com redação de PII, `traceId` do evento ao alerta e às entregas, e `GET /metrics` (inclui `outbox_pending` e `outbox_oldest_pending_age_ms`).

### Regras de exemplo (`config/rules.json`)

`high-amount`, `high-value-new-counterparty`, `risky-merchant-country` e `unusual-channel-transaction-type`, todas `STATELESS` (formato `rule.v1`, expressões sem `eval`). O arquivo é validado na inicialização: ausente, vazio, malformado ou com regra com estado/janela impede o serviço de subir.

### Simular falha de canal

`CHANNEL_CUSTOMER_FAIL=true` (ou `CHANNEL_ANTIFRAUD_FAIL=true`) faz o provedor simulado falhar; as entregas esgotam as tentativas e vão à DLQ do canal.

## Testes

```bash
npm run lint && npm test          # unitários
npm run test:int                  # Postgres + LocalStack (outbox, canais, DLQ, rastreamento)
npm run test:e2e                  # aplicação completa
npm run contracts:validate        # exemplos contra os JSON Schemas
LOAD_TOTAL=2000 LOAD_RATE=500 npm run load   # carga leve (app rodando); alvo SC-004: p99 ≤ 500 ms
```

Roteiro de validação ponta a ponta (6 cenários): [specs/001-transaction-fraud-detection/quickstart.md](specs/001-transaction-fraud-detection/quickstart.md).
