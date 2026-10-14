# Real-Time Fraud Detector

Motor de detecção de transações suspeitas em tempo real (CE 1). Decisões e requisitos em [docs/](docs/README.md). Modelo de dados do Postgres (diagrama ER): [docs/modelo-de-dados.md](docs/modelo-de-dados.md).

## Estrutura (módulos NestJS)

Um módulo por funcionalidade; cada serviço é `@Injectable()` e injetado pela classe (sem portas/tokens).

```
src/
  transactions/   consumo da fila de transações (SQS), validação (Ajv), ProcessTransactionService, RejectInvalidEventService
  rules/          regras declarativas: DeclarativeRuleEngine, validação do documento de regras, fontes: arquivo (StaticRuleRepository) e AWS AppConfig (AppConfigRuleRepository)
  alerts/         FraudAlert, decisão/dedupe, AlertRepository (Postgres + outbox), SnsEventBus, relay do outbox
  deliveries/     entrega por canal: DeliverAlertService, DeliveryRepository, provedores simulados, consumidores SQS
  dlq/            DlqMessage e SqsDlqPublisher
  health/         /health e /metrics
  config/ observability/ database/ aws/ cache/ shared/   infraestrutura transversal (config, logs/métricas, Postgres + migrações, SQS/SNS, Redis, retry)
config/rules.json  regras stateless da fonte por arquivo (dev/testes) e semente da primeira revisão no AppConfig
scripts/           teste de carga (`npm run load`) e publicação de regras (`scripts/rules/publish-rules.sh`)
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
                                   ├─▶ SQS FIFO alert-deliveries-antifraud-queue.fifo ─▶ canal interno ─ breaker aberto ─▶ adia na fila; esgotou/venceu ─▶ DLQ
                                   └─▶ SQS FIFO alert-deliveries-customer-push.fifo   ─▶ push ─ falha ─▶ SMS (fallback); sem alternativa ─▶ adia / DLQ
```

- **Um alerta por transação**: `dedupeKey = sha256("fraud-alert:v1:" + transactionId)`; reentrega e concorrência não geram segundo alerta.
- **Falha transitória** (banco, avaliação): até 3 retentativas com espera crescente na própria fila; depois `DlqMessage` `MAX_RETRIES_EXCEEDED`.
- **Entrega por canal**: `deliveryId = sha256("alert-delivery:v1:" + alertId + ":" + canal)`, estável entre retentativas; timeout, retry com backoff e jitter, e DLQ por canal (`CHANNEL_DELIVERY`). A mensagem ao cliente só leva tipo, valor formatado, data e a orientação de confirmar/contestar.
- **Observabilidade**: logs JSON com redação de PII, `traceId` do evento ao alerta e às entregas, e `GET /metrics` (inclui `outbox_pending` e `outbox_oldest_pending_age_ms`). Na AWS, a latência por alerta e os contadores do pipeline vão ao CloudWatch e alimentam o dashboard `<nome>-operacao` ([infra/terraform/README.md](infra/terraform/README.md#dashboard-operacional-cloudwatch)).

### Regras de exemplo (`config/rules.json`)

`high-amount`, `high-value-new-counterparty`, `risky-merchant-country` e `unusual-channel-transaction-type`, todas `STATELESS` (formato `rule.v1`, expressões sem `eval`). O arquivo é validado na inicialização: ausente, vazio, malformado ou com regra com estado/janela impede o serviço de subir.

### Fonte das regras (`RULES_SOURCE`)

- **Local, testes e docker-compose:** `RULES_SOURCE=file` (padrão fora de produção) lê o `config/rules.json`.
- **Produção (AWS):** o padrão é `RULES_SOURCE=appconfig`. As regras vêm do AWS AppConfig, são alteradas e revertidas **sem redeploy** com `scripts/rules/publish-rules.sh` e o arquivo embutido na imagem **não é lido**. Na partida, sem uma configuração válida em ~45 s o serviço não sobe; em execução, uma falha do AppConfig mantém a última revisão válida. Operação e detalhes em [infra/terraform/README.md](infra/terraform/README.md) e em [specs/002-appconfig-dynamic-rules](specs/002-appconfig-dynamic-rules/spec.md).
- O ambiente local não usa AWS: `npm run infra:up`, `npm test` e `npm run test:int` funcionam sem o AppConfig.

### Falha de canal: circuit breaker, fallback e kill switch

Cada canal tem um circuit breaker (por task) por trás do retry. Com o provedor do cliente fora, o alerta sai por **SMS** (fallback do push, `deliveryId` próprio); sem alternativa e com o breaker aberto, a entrega é **adiada** na fila (não vai à DLQ) e drena na recuperação; só retentativas esgotadas com o breaker fechado, ou alerta vencido (10 min), vão à DLQ do canal. Diagramas e cenários: [docs/degradacao-de-canais.md](docs/degradacao-de-canais.md). Decisões e limites: [ADR-05](docs/adr/ADR-05-estrategia-de-degradacao.md#adendo-2026-10-12-circuit-breaker-fallback-de-canal-e-kill-switch-implementados).

| Variável | Efeito |
|---|---|
| `CHANNEL_CUSTOMER_FAIL`, `CHANNEL_SMS_FAIL`, `CHANNEL_ANTIFRAUD_FAIL` | Injeta falha no provedor simulado (demonstração/testes) |
| `CHANNEL_BREAKER_FAILURE_THRESHOLD` / `CHANNEL_BREAKER_OPEN_MS` | Falhas consecutivas que abrem o breaker (5) e tempo aberto antes da sonda (30000 ms) |
| `CHANNEL_CUSTOMER_DISABLED`, `CHANNEL_SMS_DISABLED`, `CHANNEL_ANTIFRAUD_DISABLED` | Kill switch: força o breaker do canal aberto (push → SMS; os demais ficam adiados). Na AWS, variável do serviço ECS: pede novo deployment do serviço, sem deploy de código |

Roteiro de demonstração local: suba o app, ponha `CHANNEL_CUSTOMER_FAIL=true`, gere alertas (`npm run load`) e observe em `/metrics` `circuit_breaker_state{channel="PUSH"} 2`, `deliveries_total{channel="PUSH",status="fallback"}` e o SMS em `deliveries`; com `CHANNEL_SMS_FAIL=true` também, aparece `status="deferred"` sem mensagens na DLQ; ao remover as falhas a fila drena em ~30 s. A cobertura automatizada está em `test/channel-delivery.e2e-spec.ts`.

## Testes

```bash
npm run lint && npm test          # unitários
npm run test:int                  # Postgres + LocalStack (outbox, canais, DLQ, rastreamento)
npm run test:e2e                  # aplicação completa
npm run contracts:validate        # exemplos contra os JSON Schemas
LOAD_TOTAL=2000 LOAD_RATE=500 npm run load   # carga leve (app rodando); alvo SC-004: p99 ≤ 500 ms
```

Roteiro de validação ponta a ponta (6 cenários): [specs/001-transaction-fraud-detection/quickstart.md](specs/001-transaction-fraud-detection/quickstart.md).

## Limitações conhecidas e próximos passos

O que ficou de fora por prazo, em ordem de impacto no resultado. Cada item tem o desenho ou o ponto de partida já registrado.

| # | Melhoria | Por que agregaria | Ponto de partida |
|---|---|---|---|
| 1 | **Regra de velocidade (janela por conta)** | Hoje só há regras sem estado; padrões de repetição (muitas transações em pouco tempo) não são detectados. É a principal lacuna funcional | Desenho completo (`ZSET` + script Lua atômico, eventos atrasados) no [ADR-02](docs/adr/ADR-02-dedupe-e-estado-de-janela.md); o Redis já está provisionado |
| 2 | **Validação em 8.000 TPS e rajada de 25k, com repetições** | O maior degrau aprovado é **4.000 TPS** (p99 de serviço de 174 ms, 0 duplicados, ECS a 49,6% e RDS a 15,9% de CPU). A tentativa de **8.000 TPS** (7.998, 8 tasks na cota cheia, envio em lotes de 3) **reprovou em C6**: p99 de serviço de 555 ms contra 500 ms, com 0 perdas, 0 duplicados, ECS a 72,9% e RDS a 22,9%; a repetição com mais tasks depende da cota de Fargate (8 vCPU). A rajada de 25k não foi executada. Repetir separa a variação do ambiente do efeito de cada mudança e revela o gargalo (Postgres ou limite do SNS FIFO) | [Plano do teste](docs/teste-de-carga-aws-1000tps.md), [runner EC2](docs/teste-de-carga-aws-runner-ec2.md) e [registro](docs/registro-testes-aws.md) |
| 3 | **Autoscaling por backlog da fila** | O escalonamento atual segue a CPU; sob rajada, a idade da mensagem mais antiga em `transactions` reage antes e protege o SLO de 500 ms | Métrica de idade da fila já está no dashboard; a política de CPU está em `ecs.tf` |
| 4 | **Estado do circuit breaker compartilhado entre tasks** | Cada task aprende sozinha (pior caso, 3 tasks × 5 falhas até todas abrirem) | Limite descrito no [ADR-05](docs/adr/ADR-05-estrategia-de-degradacao.md); o Redis serviria de armazenamento |
| 5 | **Autenticação entre serviços com mTLS ou OAuth2 (RNF-22)** | Hoje a identidade é IAM/SigV4 nos serviços AWS, adequada ao desenho com filas, mas sem borda HTTP autenticada para produtores externos | [RNF-22](docs/03-requisitos-nao-funcionais.md) e [OpenAPI](docs/contratos/openapi.v1.yaml) |
| 6 | **Provedores reais de push, SMS e do canal antifraude** | Os canais são simulados, com injeção de falha; a resiliência está provada, a integração real não | [Degradação de canais](docs/degradacao-de-canais.md) e a interface `NotificationProvider` |
| 7 | **Retenção e expurgo de dados (LGPD)** | Não há rotina de expurgo ou anonimização das tabelas de alertas e entregas após o prazo de guarda | [Modelo de dados](docs/modelo-de-dados.md) |
| 8 | **Cenários de caos ainda não executados na AWS** | Indisponibilidade do AppConfig em runtime, publicação deliberada de regra quebrada e divergência de revisão por 20 min foram cobertos só por teste automatizado | Achado A5 do [registro](docs/registro-testes-aws.md) |
| 9 | **Fluxo de aprovação e auditoria das regras** | Hoje qualquer operador com permissão publica; o CloudTrail registra quem, mas não há revisão em dois passos | Gatilho de revisão do [ADR-03](docs/adr/ADR-03-motor-de-regras.md) |
| 10 | **Limite mínimo de cobertura no CI e remoção do Redis se a fase 2 não avançar** | Evita regressão silenciosa e elimina custo e superfície de ataque sem uso | `coverage/` já é gerado; remoção descrita nos gatilhos do ADR-02 |
