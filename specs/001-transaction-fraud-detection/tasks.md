---

description: "Task list — Detecção de Fraude em Transações (Ingestão, Validação e Alertas)"
---

# Tasks: Detecção de Fraude em Transações (Ingestão, Validação e Alertas)

**Input**: Design documents from `/specs/001-transaction-fraud-detection/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/messaging.md, quickstart.md

**Tests**: Incluídos. O plano define Jest (unitário), integração com LocalStack/Postgres, e2e e `contracts:validate`, e os critérios SC-001..SC-006 exigem verificação automatizada (reentrega, concorrência, falha de canal).

**Organization**: Tarefas agrupadas por user story. US1 e US2 são ambas P1 (US1 é o MVP; US2 é o caminho de rejeição); US3 é P2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência de tarefa incompleta)
- **[Story]**: US1, US2 ou US3
- Caminhos relativos à raiz do repositório (`/home/wali/dev/real-time-fraud-detector`)

## Contexto de código existente (não recriar)

- Portas em `src/application/ports/`: `AlertRepository` (`saveWithOutbox`, `markPublished`, `claimPendingOutbox`), `EventBus` (`publishAlert(alert, traceparent?)`), `NotificationProvider`, `RuleEngine`, `RuleRepository`.
- Domínio: `Rule`, `FraudAlert`, `TriggeredRule`, `TransactionEvent`, `IngestedEvent`, `Money`.
- Adaptador Postgres: `src/infrastructure/persistence/postgres-alert.repository.ts`; esquema base `migrations/001_init.sql`.
- Contratos JSON Schema em `docs/contratos/` (`transaction-event.v1`, `fraud-alert.v1`, `alert-delivery.v1`, `dlq-message.v1`, `rule.v1`) com exemplos válidos/inválidos em `docs/contratos/examples/`.
- `infra/localstack/init-aws.sh` já cria `transactions`, `transactions-dlq`, tópico `alerts.fifo` e filas FIFO por canal.
- `RuleEngine` está como porta: nesta feature só são aceitas regras `STATELESS` (FR-014).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependências, configuração e infraestrutura local

- [x] T001 Em `package.json`, mover `ajv` e `ajv-formats` de devDependencies para dependencies e adicionar `@aws-sdk/client-sns` (mesma faixa de versão de `@aws-sdk/client-sqs`); rodar `npm install` para atualizar `package-lock.json`
- [x] T002 [P] Acrescentar a `.env.example` as variáveis `OUTBOX_RELAY_INTERVAL_MS`, `OUTBOX_RELAY_MIN_AGE_MS`, `OUTBOX_RELAY_BATCH_SIZE`, `SNS_PUBLISH_TIMEOUT_MS`, `RULES_CONFIG_PATH`, `SQS_TRANSACTIONS_QUEUE`, `SQS_TRANSACTIONS_DLQ`, `SQS_CHANNEL_ANTIFRAUD_QUEUE`, `SQS_CHANNEL_CUSTOMER_QUEUE` e as DLQs de canal (valores locais apontando para o LocalStack), conforme `contracts/messaging.md`
- [x] T003 [P] Em `infra/localstack/init-aws.sh`, criar as DLQs `alert-deliveries-antifraud-queue-dlq.fifo` e `alert-deliveries-customer-push-dlq.fifo` e ajustar `maxReceiveCount` da fila `transactions` para uma rede de segurança acima de 3 retentativas aplicativas (D-05)
- [x] T004 [P] Criar `src/infrastructure/persistence/migrations/002_outbox_relay.sql`: adicionar a `outbox` as colunas `attempts integer NOT NULL DEFAULT 0`, `last_error text`, `next_attempt_at timestamptz NOT NULL DEFAULT now()`, `traceparent text`; trocar o índice parcial `outbox_pending_idx` por índice em `next_attempt_at WHERE published_at IS NULL` (data-model.md)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Peças compartilhadas por todas as stories

**⚠️ CRITICAL**: Nenhuma user story começa antes desta fase terminar

- [x] T005 Estender `src/infrastructure/config/config.module.ts` (`AppConfig` + `loadConfig`) com as novas variáveis de T002 (nomes de filas/DLQs, tópico SNS, parâmetros do relay, timeouts, caminho das regras, `AWS_*`/endpoint)
- [x] T006 [P] Criar `src/infrastructure/aws/aws-clients.module.ts` com providers Nest para `SQSClient` e `SNSClient` (endpoint LocalStack via config, TLS em produção — FR-026)
- [x] T007 [P] Criar `src/application/shared/retry.ts`: utilitário de timeout + retry com backoff exponencial e jitter (função pura, injetável `sleep`/`random`) e `src/application/shared/retry.spec.ts` cobrindo limite de tentativas, crescimento da espera e propagação do último erro
- [x] T008 [P] Criar `src/infrastructure/observability/` com `logger.ts` (log JSON estruturado com `traceId`/`alertId`, redação de campos PII: IP, geolocalização, identificadores em claro, segredos — FR-009/FR-027) e `metrics.ts` (registro simples de contadores/gauges: `events_processed_total{result}`, `events_rejected_total{reason}`, `alerts_total`, `alert_latency_ms`, `outbox_pending`, `outbox_publish_total{result}`, `outbox_relay_republished_total`, `deliveries_total{channel,status}`, `dlq_total{stage}`) e `logger.spec.ts` provando que um evento com `ipAddress`/`geo` não vaza nos logs (SC-007)
- [x] T009 [P] Criar a porta `src/application/ports/event-validator.port.ts` (`validate(raw: string): ValidationResult` com `ok` + `TransactionEvent`, ou `error` com `reasonCode` ∈ `DESERIALIZATION_ERROR | SCHEMA_INVALID | UNSUPPORTED_VERSION` e `fieldPath`, sem conteúdo da mensagem) e a porta `src/application/ports/dlq-publisher.port.ts` (`publish(dlqMessage: DlqMessage)`, tipo `DlqMessage` espelhando `dlq-message.v1`, em `src/domain/dlq/dlq-message.ts`)
- [x] T010 Implementar `src/infrastructure/contracts/ajv-transaction-event.validator.ts` (porta de T009): compila `docs/contratos/transaction-event.v1.schema.json` com `ajv` + `ajv-formats`, rejeita JSON ilegível, campos ausentes/desconhecidos, valores inválidos e versão major ≠ 1, aceita `1.x` (FR-004..FR-006); teste `ajv-transaction-event.validator.spec.ts` usando todos os `docs/contratos/examples/transaction-event.*` (válidos aceitos, inválidos rejeitados com o código esperado, `reversed` válido)
- [x] T011 [P] Implementar `src/infrastructure/messaging/sqs-dlq.publisher.ts` (porta `DlqPublisher`): monta `DlqMessage v1` (etapa, `reasonCode`, `reasonDetail` sem PII, tentativas, original preservado) e envia à fila de DLQ indicada pela mensagem/etapa; teste unitário com `SQSClient` mockado validando o corpo contra `dlq-message.v1.schema.json`

**Checkpoint**: Fundação pronta — stories podem começar

---

## Phase 3: User Story 1 - Transação suspeita gera alerta (Priority: P1) 🎯 MVP

**Goal**: Ler evento válido da SQS, avaliar regras stateless, gerar no máximo um alerta por transação via outbox transacional + publicação imediata no SNS, com relay para republicar pendentes.

**Independent Test**: Publicar em `transactions` um evento válido que viole uma regra e outro que não viole; o primeiro gera exatamente 1 alerta (com regras acionadas) em `alerts`/`outbox` publicado no SNS, o segundo nenhum; ambos saem da fila. Reentrega/concorrência não gera segundo alerta.

### Tests for User Story 1 ⚠️ (escrever primeiro; devem falhar antes da implementação)

- [x] T012 [P] [US1] Teste unitário `src/domain/alert/decision.spec.ts`: consolidação — severidade = maior entre as regras acionadas, pontuação = soma dos pesos limitada a 100, múltiplas regras → um único alerta; sem regra acionada → decisão vazia (FR-013, FR-016)
- [x] T013 [P] [US1] Teste unitário `src/infrastructure/rules/rules-config.loader.spec.ts`: configuração ausente, vazia, malformada, regra com `kind: WINDOWED`/janela/estado ou JSON inválido contra `rule.v1.schema.json` → erro claro e sem PII (FR-014, FR-014b); usar `docs/contratos/examples/rule.*`
- [x] T014 [P] [US1] Teste unitário `src/infrastructure/rules/declarative-rule-engine.spec.ts`: as 4 regras de exemplo (valor alto, contraparte nova com valor alto, país de risco, canal+tipo incomum) acionam/não acionam; determinismo — mesmo evento, mesma decisão, qualquer ordem/repetição (FR-010..FR-012, SC-003); evidências sem PII (FR-015)
- [x] T015 [P] [US1] Teste unitário `src/application/use-cases/process-transaction.spec.ts` (portas fakes): suspeito → `saveWithOutbox` + publicação + `markPublished`; sem suspeita → sem alerta, confirmado; estorno → sem avaliação nem alerta; recusado → avaliado; duplicata (`saveWithOutbox=false`) → sem novo alerta e republica se outbox pendente (D-04); falha do `EventBus` não falha o caso de uso; erro na avaliação/persistência → lança erro de falha transitória
- [x] T016 [P] [US1] Teste de integração `test/integration/outbox-publish.int-spec.ts` (Postgres + LocalStack): cenários 1, 3 e 4 do quickstart — alerta e outbox atômicos, publicação imediata preenche `published_at`, SNS indisponível deixa pendente e o relay publica depois, reentrega e processamento concorrente do mesmo evento resultam em exatamente 1 alerta (SC-002)
- [x] T017 [P] [US1] Teste de integração `test/integration/relay-outbox.int-spec.ts`: `claimPendingOutbox` com `FOR UPDATE SKIP LOCKED` entre duas instâncias concorrentes não processa a mesma linha; backoff via `next_attempt_at`/`attempts` incrementa em falha

### Implementation for User Story 1

- [x] T018 [P] [US1] Criar `src/domain/alert/decision.ts`: função pura que consolida `RuleMatch[]` em decisão (`triggeredRules`, `severity` máxima, `score = min(100, soma dos pesos)`), e `src/domain/alert/dedupe-key.ts` com `sha256("fraud-alert:v1:" + transactionId)`; ajustar `src/domain/alert/fraud-alert.ts` com um *builder* de `FraudAlert` (marcos `ingestedAt/consumedAt/detectedAt`, `status: OPEN`, `traceId`)
- [x] T019 [P] [US1] Criar `config/rules.json` (ou o caminho de `RULES_CONFIG_PATH`) com as 4 regras `STATELESS` de exemplo válidas em `rule.v1` (`HIGH_AMOUNT`, `HIGH_AMOUNT_NEW_COUNTERPARTY`, `RISKY_MERCHANT_COUNTRY`, `UNUSUAL_CHANNEL_TRANSACTION_TYPE`) com limiares/listas em `params` e `expression` na sintaxe adotada por T020
- [x] T020 [US1] Implementar `src/infrastructure/rules/declarative-rule-engine.ts` (porta `RuleEngine` de `rule-engine.port.ts`): avaliador sem `eval` das expressões de `Rule.expression` (comparações, `&&`, `||`, `!`, `in`, `has()`, acesso a `tx.*` e `params.*`), `validate()` rejeita `kind != STATELESS` e referência a estado/janela; `evaluate()` devolve `RuleMatch[]` com evidências sem PII
- [x] T021 [US1] Implementar `src/infrastructure/rules/rules-config.loader.ts`: lê e valida o arquivo de regras (T019) com `rule.v1.schema.json` + `RuleEngine.validate`, devolve snapshot imutável em memória; falha de forma explícita e sem PII para ausente/vazio/malformado/regra inválida; implementar `RuleRepository` em memória sobre o snapshot (`src/infrastructure/rules/static-rule.repository.ts`)
- [x] T022 [US1] Atualizar `src/infrastructure/persistence/postgres-alert.repository.ts`: `saveWithOutbox` grava `traceparent`; `claimPendingOutbox` filtra `next_attempt_at <= now()` e `published_at IS NULL` com `FOR UPDATE SKIP LOCKED`; `markPublished` atualiza `outbox` e `alerts` na mesma transação (idempotente); novos métodos `recordPublishFailure(alertId, errorCode)` (incrementa `attempts`, define `last_error` sem PII e `next_attempt_at` com backoff) e `isOutboxPending(alertId)`; refletir os novos métodos em `src/application/ports/alert-repository.port.ts`
- [x] T023 [P] [US1] Implementar `src/infrastructure/messaging/sns-event-bus.ts` (porta `EventBus`): `PublishCommand` em `alerts.fifo` com corpo `FraudAlert v1`, `MessageGroupId=accountId`, `MessageDeduplicationId=dedupeKey`, atributos `schema-version`, `message-id`, `traceparent`; timeout `SNS_PUBLISH_TIMEOUT_MS` + `retry` de T007; teste unitário com `SNSClient` mockado
- [x] T024 [US1] Implementar `src/application/use-cases/process-transaction.ts`: (1) estorno → conclui sem avaliar; (2) avalia regras; (3) sem suspeita → conclui; (4) constrói alerta; (5) `saveWithOutbox`; (6) se criado, publica no `EventBus` e `markPublished`, em falha `recordPublishFailure` sem propagar erro; (7) se duplicado, republica quando `isOutboxPending`; (8) erros de avaliação/persistência propagam como falha transitória; registrar métricas/logs (T008) e `publishedAt`/latência (FR-018)
- [x] T025 [US1] Implementar `src/application/use-cases/relay-outbox.ts`: reivindica lote pendente (`claimPendingOutbox(batchSize, minAge)`), publica via `EventBus`, `markPublished` ou `recordPublishFailure`; atualiza `outbox_pending`, `outbox_publish_total`, `outbox_relay_republished_total`
- [x] T026 [US1] Implementar `src/infrastructure/messaging/sqs-transaction.consumer.ts`: long polling da fila `transactions`, lote concorrente, chama validador (T010) e `ProcessTransaction`; só exclui a mensagem após resultado durável (FR-002, FR-019); em falha transitória usa `ChangeMessageVisibility` com espera crescente baseada em `ApproximateReceiveCount`, e ao esgotar 3 retentativas publica `DlqMessage` `MAX_RETRIES_EXCEEDED` (etapa `PERSISTENCE` ou `ALERT_PUBLISH`) e exclui o original (FR-003a); eventos inválidos ficam para a US2 (ver T031) — aqui deixar o ponto de extensão `onInvalid`
- [x] T027 [US1] Criar `src/infrastructure/messaging/outbox-relay.scheduler.ts` (intervalo `OUTBOX_RELAY_INTERVAL_MS`, sem sobreposição de execuções) e `src/infrastructure/messaging/messaging.module.ts` (Nest module) ligando consumidor, relay, `SnsEventBus`, `PostgresAlertRepository`, motor de regras e loader em `src/app.module.ts`; o loader de regras roda na inicialização e, em erro, impede o consumo e derruba o processo com log claro (FR-014b)
- [x] T028 [US1] Teste e2e `test/process-transaction.e2e-spec.ts` (cenários 1 e 2 do quickstart) e confirmar que T012–T017 passam; ajustar `src/infrastructure/health/health.controller.ts` para readiness não depender do SNS (D-07)

**Checkpoint**: US1 funcional e testável sozinha (MVP)

---

## Phase 4: User Story 2 - Evento inválido é rejeitado sem perda (Priority: P1)

**Goal**: Toda mensagem inválida é rejeitada sem avaliação, registrada sem PII e enviada à DLQ com motivo e original preservado, sem reentrega indefinida.

**Independent Test**: Publicar eventos com defeitos distintos (campo ausente, tipo errado, valor negativo, campo extra com dado pessoal, JSON truncado, versão `2.0`); nenhum gera alerta e cada um aparece em `transactions-dlq` com código de motivo e conteúdo original.

### Tests for User Story 2 ⚠️

- [ ] T029 [P] [US2] Teste unitário `src/application/use-cases/reject-invalid-event.spec.ts`: cada `reasonCode` (`DESERIALIZATION_ERROR`, `SCHEMA_INVALID`, `UNSUPPORTED_VERSION`) gera `DlqMessage` com etapa `VALIDATION`, detalhe só com `fieldPath`/código, original preservado, métrica `events_rejected_total` incrementada e nenhum log contém o conteúdo (FR-007, FR-009, FR-008)
- [ ] T030 [P] [US2] Teste de integração `test/integration/invalid-events.int-spec.ts` (cenário 6 do quickstart): publica todos os exemplos `transaction-event.*.invalid.json` + JSON truncado + versão `2.0`; verifica DLQ com motivo/original, ausência de linhas em `alerts`/`outbox`, remoção da mensagem de entrada e logs sem PII (SC-001, SC-007)

### Implementation for User Story 2

- [ ] T031 [US2] Implementar `src/application/use-cases/reject-invalid-event.ts`: recebe a mensagem bruta + resultado de validação inválida, monta o `DlqMessage` (etapa `VALIDATION`), chama `DlqPublisher`, registra log estruturado/métrica sem PII; falha ao publicar na DLQ propaga erro (mensagem não é excluída)
- [ ] T032 [US2] Em `src/infrastructure/messaging/sqs-transaction.consumer.ts`, implementar o ponto de extensão `onInvalid` (T026): validação inválida → `RejectInvalidEvent` e exclusão da mensagem original somente após o envio à DLQ ser confirmado; nunca chama `ProcessTransaction` (FR-008)
- [ ] T033 [US2] Teste e2e `test/reject-invalid.e2e-spec.ts` cobrindo mistura de válidos e inválidos na mesma fila (inválidos não bloqueiam os válidos) e confirmar T029/T030 verdes

**Checkpoint**: US1 e US2 funcionam independentemente

---

## Phase 5: User Story 3 - Alerta chega aos canais interno e externo (Priority: P2)

**Goal**: Cada alerta é entregue ao canal interno e ao externo de forma independente, com `deliveryId` estável, retentativa com espera crescente e DLQ por canal; mensagem ao cliente sem dados internos.

**Independent Test**: Gerar um alerta e verificar uma entrega por canal; simular indisponibilidade de um canal e verificar que o outro é entregue e que a falha é retentada e depois vai à DLQ do canal.

### Tests for User Story 3 ⚠️

- [ ] T034 [P] [US3] Teste unitário `src/domain/alert/delivery-id.spec.ts` e `src/application/use-cases/deliver-alert.spec.ts` (provedor fake): `deliveryId = sha256("alert-delivery:v1:" + alertId + ":" + canal)` estável; entrega já `DELIVERED` não é reenviada (FR-017a/FR-024); falha de um canal não afeta o outro (FR-021); esgotadas as tentativas → `DlqMessage` `CHANNEL_DELIVERY`/`MAX_RETRIES_EXCEEDED` e `status=DEAD_LETTERED` (FR-023)
- [ ] T035 [P] [US3] Teste unitário `src/infrastructure/channels/customer-push.provider.spec.ts`: payload ao cliente contém só tipo, valor formatado e data + orientação de confirmar/contestar; nunca contém regras, pontuação, severidade ou evidências (FR-025); validar `AlertDelivery v1` com `docs/contratos/examples/alert-delivery.*` (o exemplo `customer-on-internal-channel.invalid.json` deve ser rejeitado)
- [ ] T036 [P] [US3] Teste de integração `test/integration/channel-delivery.int-spec.ts` (cenários 1 e 5 do quickstart): alerta no SNS chega às duas filas de canal; provedor do cliente falhando → canal interno entregue, cliente retentado e, ao esgotar, DLQ do canal; latência de detecção não aumenta (SC-005)

### Implementation for User Story 3

- [ ] T037 [P] [US3] Criar `src/domain/alert/delivery-id.ts` (hash estável) e `src/domain/alert/alert-delivery.ts` (tipo espelhando `alert-delivery.v1` com `audience`, `channel`, `template`)
- [ ] T038 [P] [US3] Criar `src/application/ports/delivery-repository.port.ts` e `src/infrastructure/persistence/postgres-delivery.repository.ts` sobre a tabela `deliveries`: `register(delivery)` com `INSERT … ON CONFLICT DO NOTHING`, `markDelivered`, `markDeadLettered`, `recordAttempt(error)`, `isDelivered(deliveryId)`
- [ ] T039 [P] [US3] Implementar `src/infrastructure/channels/antifraud-queue.provider.ts` (canal `ANTIFRAUD_QUEUE`, `audience=ANTIFRAUD_TEAM`, alerta completo) e `src/infrastructure/channels/customer-push.provider.ts` (canal `PUSH`, `audience=CUSTOMER`, `template.id=suspicious-transaction.v1`, `params` só com tipo, valor formatado e data; provedor simulado com falha injetável por configuração para testes), ambos implementando `NotificationProvider`
- [ ] T040 [US3] Implementar `src/application/use-cases/deliver-alert.ts`: calcula `deliveryId`, registra a entrega, ignora se `DELIVERED`, envia com timeout + retry/backoff (T007), marca `DELIVERED`; ao esgotar, publica `DlqMessage` (`CHANNEL_DELIVERY`, `MAX_RETRIES_EXCEEDED`, sem PII) na DLQ do canal, marca `DEAD_LETTERED`; métrica `deliveries_total{channel,status}` e propagação de `traceId` (FR-029)
- [ ] T041 [US3] Implementar `src/infrastructure/messaging/sqs-channel.consumer.ts`: um consumidor independente por canal lendo a fila FIFO do canal (corpo = `FraudAlert v1` bruto, `RawMessageDelivery`), invoca `DeliverAlert` com o provedor do canal; exclui a mensagem só após `DELIVERED` ou `DEAD_LETTERED` durável; falha de um canal não bloqueia o outro (loops isolados)
- [ ] T042 [US3] Registrar provedores, repositório de entregas e consumidores de canal em `src/infrastructure/messaging/messaging.module.ts`/`src/app.module.ts`; teste e2e `test/channel-delivery.e2e-spec.ts` com falha injetada no canal do cliente

**Checkpoint**: Todas as stories independentemente funcionais

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Garantias transversais e validação final

- [ ] T043 [P] Teste de propriedade/determinismo `src/application/use-cases/determinism.spec.ts`: mesmo evento em ordens e repetições diferentes e intercalado com outros eventos produz a mesma decisão, sem leitura de estado externo (SC-003, FR-011)
- [ ] T044 [P] Teste de invariantes `test/integration/no-silent-loss.int-spec.ts`: todo evento de entrada termina em exatamente um estado (sem suspeita, alerta gerado, DLQ) e toda entrega em `DELIVERED` ou DLQ (SC-006)
- [ ] T045 [P] Exposição de métricas e verificação (`/metrics` ou equivalente em `src/infrastructure/health/`) com `outbox_pending` e idade da linha pendente mais antiga; revisar que logs/métricas não contêm PII em todos os adaptadores (FR-027, FR-028, SC-007, SC-008)
- [ ] T046 [P] Garantir atributos de rastreamento: `traceId`/`traceparent` propagados do evento até alerta, SNS e entregas (FR-029); teste em `test/integration/trace-propagation.int-spec.ts`
- [ ] T047 [P] Atualizar `README.md` (como rodar, regras de exemplo, topologia SNS/SQS) e referenciar `specs/001-transaction-fraud-detection/quickstart.md`
- [ ] T048 Teste de carga leve (script em `test/load/` ou `scripts/`) para verificar SC-004 (p99 ≤ 500 ms, alvo 8.000 TPS) e registrar se o teto do SNS FIFO (D-06) foi atingido
- [ ] T049 Executar `npm run lint && npm test && npm run test:int && npm run test:e2e && npm run contracts:validate` e percorrer os 6 cenários de `quickstart.md`; corrigir divergências

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências
- **Foundational (Phase 2)**: depende do Setup; bloqueia todas as stories
- **US1 (Phase 3)**: depende da Foundational
- **US2 (Phase 4)**: depende da Foundational; T032 estende o consumidor criado em T026 (US1)
- **US3 (Phase 5)**: depende da Foundational; consome alertas publicados no SNS (T023/T024 da US1) — testável de forma independente injetando um `FraudAlert` direto no tópico/fila do canal
- **Polish (Phase 6)**: depende das stories desejadas

### Within Each Story

- Testes primeiro (devem falhar) → domínio/portas → adaptadores → casos de uso → consumidores/módulos → e2e
- T020 antes de T021 e T014; T022 antes de T024/T025; T024 antes de T026; T026 antes de T032; T038/T039 antes de T040; T040 antes de T041

### Dependências específicas

- T010 depende de T009; T011 depende de T009
- T021 depende de T019, T020
- T027 depende de T021, T023, T025, T026
- T041 depende de T040; T042 depende de T041

### Parallel Opportunities

- Setup: T002, T003, T004 em paralelo após T001
- Foundational: T006, T007, T008, T009 em paralelo; depois T010 e T011
- US1 testes: T012–T017 em paralelo; implementação: T018, T019, T023 em paralelo
- US2 e US3 podem ser desenvolvidas em paralelo após a Foundational (com a ressalva de T032)
- US3: T034–T036 em paralelo; T037, T038, T039 em paralelo

## Parallel Example: User Story 1

```text
# Testes em paralelo:
Task: "Teste unitário de consolidação em src/domain/alert/decision.spec.ts"
Task: "Teste do loader de regras em src/infrastructure/rules/rules-config.loader.spec.ts"
Task: "Teste do motor declarativo em src/infrastructure/rules/declarative-rule-engine.spec.ts"
Task: "Teste do caso de uso em src/application/use-cases/process-transaction.spec.ts"

# Implementação em paralelo:
Task: "Criar decision.ts e dedupe-key.ts em src/domain/alert/"
Task: "Criar config/rules.json com as 4 regras de exemplo"
Task: "Implementar src/infrastructure/messaging/sns-event-bus.ts"
```

## Implementation Strategy

### MVP First (US1)

1. Setup → Foundational
2. US1 (T012–T028)
3. **PARAR e validar**: cenários 1–4 do quickstart
4. Demonstrar

### Incremental Delivery

1. Setup + Foundational
2. US1 → validar (MVP: detecção + outbox + SNS)
3. US2 → validar (rejeição com DLQ; também P1, recomendada antes de qualquer uso real)
4. US3 → validar (entrega multicanal)
5. Polish

## Notes

- [P] = arquivos diferentes, sem dependência incompleta
- Escrever os testes antes e vê-los falhar
- Não fazer commit/push sem pedido explícito do usuário (AGENTS.md)
- Regras de negócio definitivas e regras com estado/janela estão fora do escopo (spec, Assumptions)
