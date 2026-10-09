# Fluxo de processamento: da transação ao alerta entregue

Mapa do fluxo **como está implementado**, com referência ao código. Cada etapa tem o seu diagrama; a visão geral só mostra como elas se encadeiam. Contratos em [contratos/](contratos/README.md).

## Sumário

0. [Visão geral](#0-visão-geral)
1. [Recebimento e validação](#1-recebimento-e-validação)
2. [Avaliação de regras e decisão](#2-avaliação-de-regras-e-decisão)
3. [Persistência atômica (alerta + outbox)](#3-persistência-atômica-alerta--outbox)
4. [Falhas transitórias e retentativas da entrada](#4-falhas-transitórias-e-retentativas-da-entrada)
5. [Publicação no SNS e marcos de tempo](#5-publicação-no-sns-e-marcos-de-tempo)
6. [Relay do outbox](#6-relay-do-outbox)
7. [Fan-out e consumo por canal](#7-fan-out-e-consumo-por-canal)
8. [Entrega idempotente ao canal](#8-entrega-idempotente-ao-canal)
9. [Escritas no banco](#9-escritas-no-banco)
10. [Garantias](#10-garantias)

---

## 0. Visão geral

```mermaid
flowchart LR
    IN[(SQS<br/>transactions)] --> A[1. Recebimento<br/>e validação]
    A -- inválido --> DLQ1[(DLQ<br/>transactions-dlq)]
    A -- válido --> B[2. Regras<br/>e decisão]
    B -- sem alerta --> FIM1([fim: apaga mensagem])
    B -- suspeito --> C[3. Persistência<br/>alerta + outbox]
    C --> D[5. Publicação<br/>SNS alerts.fifo]
    D -. falhou .-> R[6. Relay<br/>do outbox]
    R --> D
    D --> E[7. Fan-out<br/>2 filas FIFO]
    E --> F[8. Entrega<br/>por canal]
    F -- esgotou tentativas --> DLQ2[(DLQ do canal)]
    A -. falha transitória .-> T[4. Retentativas<br/>da entrada]
    B -.-> T
    C -.-> T
    T -- esgotou --> DLQ1
```

| Etapa | Classe / arquivo principal |
|---|---|
| 1 | `SqsTransactionConsumer` (`src/transactions/sqs-transaction.consumer.ts`), `AjvTransactionEventValidator`, `RejectInvalidEventService` |
| 2 | `ProcessTransactionService`, `DeclarativeRuleEngine`, `consolidate` (`src/alerts/decision.ts`) |
| 3 | `AlertRepository.saveWithOutbox` (`src/alerts/alert.repository.ts`) |
| 4 | `SqsTransactionConsumer.handleTransientFailure` |
| 5 | `OutboxEntryPublisherService`, `SnsEventBus` |
| 6 | `OutboxRelayScheduler`, `RelayOutboxService` |
| 7 | `infra/localstack/init-aws.sh`, `ChannelConsumers`, `SqsChannelConsumer` |
| 8 | `DeliverAlertService`, `DeliveryRepository`, `AntifraudQueueProvider`, `CustomerPushProvider` |

---

## 1. Recebimento e validação

`pollLoop` faz long polling (até 10 mensagens, espera de 2 s) e chama `handle()` em paralelo para cada uma. `handle()` **nunca lança**: qualquer falha deixa a mensagem na fila.

```mermaid
sequenceDiagram
    autonumber
    participant Q as SQS transactions
    participant C as SqsTransactionConsumer
    participant V as AjvTransactionEventValidator
    participant J as RejectInvalidEventService
    participant D as SQS transactions-dlq
    participant P as ProcessTransactionService

    C->>Q: ReceiveMessage (10 msgs, 2 s)<br/>SentTimestamp, ApproximateReceiveCount, traceparent
    Q-->>C: mensagens
    loop cada mensagem (em paralelo)
        C->>V: validate(rawBody)
        alt inválido (DESERIALIZATION_ERROR,<br/>UNSUPPORTED_VERSION, SCHEMA_INVALID)
            C->>J: execute({rawBody, result, traceparent})
            J->>D: publish(DlqMessage, stage INGEST_VALIDATION)
            D-->>J: confirmado
            J-->>C: ok (métricas e log sem conteúdo do evento)
            C->>Q: DeleteMessage
        else válido
            Note over C: monta IngestedEvent<br/>ingestedAt = SentTimestamp do SQS<br/>consumedAt = agora
            C->>P: execute(ingested)
        end
    end
```

Pontos importantes:

- **A mensagem de entrada só é apagada depois que a DLQ confirmou.** Se o envio à DLQ falhar, `RejectInvalidEventService` lança e a mensagem volta à fila.
- `ingestedAt` vem do relógio do broker (`SentTimestamp`), não do produtor. Se o atributo faltar, usa-se o relógio local.
- Log e métricas da rejeição carregam só o código do motivo e o caminho do campo, nunca o conteúdo.

---

## 2. Avaliação de regras e decisão

`ProcessTransactionService.execute` (`process-transaction.service.ts:236`) decide se há alerta. Esta etapa não toca no banco.

```mermaid
flowchart TD
    S([IngestedEvent]) --> T{eventType ==<br/>TRANSACTION_REVERSED?}
    T -- sim --> R1[/REVERSAL_SKIPPED<br/>sem avaliar, sem alerta/]
    T -- não --> L[StaticRuleRepository<br/>loadActiveSnapshot]
    L --> E[DeclarativeRuleEngine<br/>evaluate regras, tx]
    E -- erro --> X[[ProcessingError<br/>stage RULE_EVALUATION]]
    E --> M{para cada regra}
    M -- mode SHADOW --> SK[ignora: avalia mas<br/>não gera alerta]
    M -- ACTIVE e aplicável --> AST[avalia o AST da expressão<br/>e coleta evidência]
    AST --> MATCH[lista de matches]
    MATCH --> CON[consolidate]
    CON --> Q{algum match?}
    Q -- não --> R2[/NO_ALERT/]
    Q -- sim --> DEC[severidade = maior entre as regras<br/>score = soma dos pesos, teto 100]
    DEC --> NEXT([segue para persistência])
```

- Regras vêm de `config/rules.json` (sem redeploy de código). Regras em `SHADOW` são avaliadas, mas nunca geram alerta.
- A evidência nunca inclui dados de origem (IP, geolocalização).
- A decisão é determinística: o relógio e o gerador de id são injetáveis (`now`, `newId`) e há teste de determinismo (`determinism.spec.ts`).

---

## 3. Persistência atômica (alerta + outbox)

O alerta é montado (`status: OPEN`, `dedupeKey = dedupeKeyOf(transactionId)`, um alerta por transação) e gravado junto com a linha do outbox, **na mesma transação**.

```mermaid
sequenceDiagram
    autonumber
    participant P as ProcessTransactionService
    participant R as AlertRepository
    participant DB as Postgres

    P->>R: saveWithOutbox(alert, traceparent)
    R->>DB: BEGIN
    R->>DB: INSERT INTO alerts ... ON CONFLICT (dedupe_key) DO NOTHING
    alt rowCount == 0 (duplicata)
        R->>DB: ROLLBACK
        R-->>P: false
        Note over P: ver o ramo de duplicata abaixo
    else inserido
        R->>DB: INSERT INTO outbox (alert_id, payload, traceparent)
        R->>DB: COMMIT
        R-->>P: true
        Note over P: alerts_total++<br/>chama o publicador imediato (etapa 5)
    end
    opt erro de banco
        R->>DB: ROLLBACK
        R-->>P: lança
        Note over P: vira ProcessingError(PERSISTENCE)<br/>ver etapa 4
    end
```

**Ramo de duplicata** (reentrega do evento de entrada):

```mermaid
flowchart TD
    D([saveWithOutbox == false]) --> M[métrica events_processed_total<br/>result=duplicate]
    M --> F[findPendingByDedupeKey]
    F --> P{linha do outbox<br/>ainda pendente?}
    P -- sim --> PUB[publisher.publish: completa a publicação]
    P -- não --> NADA[nada a fazer]
    PUB --> OUT[/DUPLICATE/]
    NADA --> OUT
```

Nenhum alerta novo é criado. Se o processo tinha caído depois do commit e antes da publicação, a reentrega completa o trabalho.

---

## 4. Falhas transitórias e retentativas da entrada

`ProcessTransactionService` só lança nas falhas transitórias (`RULE_EVALUATION` e `PERSISTENCE`). O consumidor decide entre retentar e mandar à DLQ em `handleTransientFailure`.

```mermaid
flowchart TD
    E[[ProcessingError]] --> RC[receiveCount =<br/>ApproximateReceiveCount]
    RC --> Q{receiveCount<br/>menor ou igual a MAX_RETRIES = 3?}
    Q -- sim --> V["ChangeMessageVisibility<br/>timeout = min(30, 2^receiveCount) s"]
    V --> BACK([mensagem volta à fila<br/>após o timeout])
    Q -- não --> B[buildDlqMessage<br/>stage, MAX_RETRIES_EXCEEDED,<br/>rawBody, transactionId, traceparent]
    B --> PUB[publica em transactions-dlq]
    PUB --> M[dlq_total++ e log de erro]
    M --> DEL[DeleteMessage]
```

| Tentativa (receiveCount) | Próxima visibilidade |
|---|---|
| 1 | 2 s |
| 2 | 4 s |
| 3 | 8 s |
| 4 | vai à DLQ |

- Em qualquer falha de infraestrutura fora desse caminho (por exemplo, o próprio `ChangeMessageVisibility`), o `catch` externo de `handle()` só registra e a mensagem volta ao fim da visibilidade padrão da fila.
- Como rede de segurança extra, a fila `transactions` tem uma redrive policy para a `transactions-dlq` com `maxReceiveCount=10` (`init-aws.sh:10`).

---

## 5. Publicação no SNS e marcos de tempo

Logo após o commit, `OutboxEntryPublisherService.publish` envia o alerta ao tópico FIFO `alerts.fifo` e marca a linha como publicada. **Nunca lança**: se falhar, o relay assume.

```mermaid
sequenceDiagram
    autonumber
    participant P as OutboxEntryPublisherService
    participant B as SnsEventBus
    participant SNS as SNS alerts.fifo
    participant R as AlertRepository
    participant M as Métricas

    Note over P: sentAt = now()<br/>corpo.publishedAt = sentAt<br/>corpo.latencyMs = sentAt - ingestedAt
    P->>B: publishAlert(alertaCarimbado, traceparent)
    B->>SNS: Publish (até 3 tentativas, com timeout)<br/>GroupId = accountId<br/>DeduplicationId = dedupeKey
    alt falhou
        B-->>P: lança
        P->>M: outbox_publish_total{failure}++
        P->>R: recordPublishFailure(alertId, errorCode)
        Note over R: attempts++, last_error,<br/>next_attempt_at com backoff
        P-->>P: retorna false (relay tenta de novo)
    else aceito
        SNS-->>B: ok
        B-->>P: ok
        Note over P: acceptedAt = now()
        P->>M: outbox_publish_total{success}++<br/>alert_latency_ms = acceptedAt - ingestedAt
        P->>R: markPublished(alertId, acceptedAt)
        Note over R: published_at no outbox e em alerts<br/>(idempotente, preserva o primeiro instante)
        P-->>P: retorna true
    end
```

### Dois instantes, dois significados

O contrato exige `publishedAt` no corpo da mensagem, mas o aceite pelo SNS só é conhecido depois do `publish`. Por isso há dois relógios:

```mermaid
flowchart LR
    I["ingestedAt<br/>broker aceitou o evento"] --> CO["consumedAt<br/>motor começou"]
    CO --> DE["detectedAt<br/>decisão pronta"]
    DE --> SE["sentAt<br/>(corpo.publishedAt)<br/>envio ao barramento"]
    SE --> AC["acceptedAt<br/>SNS aceitou<br/>(published_at no banco)"]
    I -. "corpo.latencyMs" .-> SE
    I -. "alert_latency_ms<br/>fim do SLO" .-> AC
```

| Valor | Instante | Onde aparece |
|---|---|---|
| `publishedAt` e `latencyMs` do **corpo** | `sentAt`: momento do envio ao barramento, tirado antes do `publish` | Mensagem entregue aos consumidores do tópico |
| `alert_latency_ms` | `acceptedAt`: após o `await bus.publishAlert(...)` | Métrica; é o que mede o SLO |
| `published_at` (`outbox` e `alerts`) | `acceptedAt` | Banco; usado por `scripts/load-test.ts` |

`acceptedAt` inclui o tempo do `publish` com timeout e retentativas, então é igual ou maior que `sentAt`. Em condições normais a diferença é de poucos ms; sob lentidão do SNS, ela é justamente o que a métrica passa a mostrar. O tempo do `markPublished` fica fora das duas medições.

Se o SNS aceitou mas o `markPublished` falhou, o publicador só registra um aviso. O relay republica depois e o SNS FIFO descarta a duplicata pelo `dedupeKey`, valendo o primeiro envio.

---

## 6. Relay do outbox

Cobre dois casos: a publicação imediata falhou, ou o processo caiu depois do commit e antes de publicar.

```mermaid
sequenceDiagram
    autonumber
    participant S as OutboxRelayScheduler
    participant RS as RelayOutboxService
    participant R as AlertRepository
    participant DB as Postgres
    participant P as OutboxEntryPublisherService

    loop a cada outboxRelay.intervalMs (sem sobreposição)
        S->>RS: runOnce()
        RS->>R: claimPendingOutbox(batchSize, minAgeMs)
        R->>DB: UPDATE outbox SET next_attempt_at = now()+lease<br/>WHERE alert_id IN (SELECT ... FOR UPDATE SKIP LOCKED)
        DB-->>R: linhas reivindicadas
        R-->>RS: entradas
        loop cada entrada
            RS->>P: publish(entry)
            alt publicou
                Note over RS: outbox_relay_republished_total++
            else falhou
                Note over P: recordPublishFailure<br/>(backoff 1 s, 2 s, 4 s ... até 60 s)
            end
        end
        RS->>R: countPendingOutbox()
        Note over RS: gauges outbox_pending e<br/>outbox_oldest_pending_age_ms
    end
```

- Só pega linhas **sem `published_at`**, com `next_attempt_at` vencido e criadas há mais de `minAgeMs`. Assim o relay não disputa com a publicação imediata.
- `FOR UPDATE SKIP LOCKED` mais o lease em `next_attempt_at` evitam que duas instâncias processem a mesma linha.
- O agendador só liga se `consumers.enabled`, usa `setInterval` com `unref()` e, no desligamento, espera a execução corrente terminar.

---

## 7. Fan-out e consumo por canal

O SNS FIFO distribui o mesmo alerta para uma fila FIFO por canal (`RawMessageDelivery=true`, então o corpo é o `FraudAlert` puro).

```mermaid
flowchart LR
    SNS[SNS alerts.fifo] --> QA[(alert-deliveries-<br/>antifraud-queue.fifo)]
    SNS --> QP[(alert-deliveries-<br/>customer-push.fifo)]
    QA --> CA[SqsChannelConsumer<br/>ANTIFRAUD_QUEUE]
    QP --> CP[SqsChannelConsumer<br/>PUSH]
    CA -. poison / esgotou .-> DA[(...antifraud-queue-dlq.fifo)]
    CP -. poison / esgotou .-> DP[(...customer-push-dlq.fifo)]
```

`ChannelConsumers` sobe um `SqsChannelConsumer` por provedor, cada um com seus próprios loops, então **um canal lento ou fora do ar não bloqueia o outro**. Só sobem se `consumers.enabled` e `consumers.channelsEnabled`.

Dentro de cada consumidor, a ordem por conta é preservada:

```mermaid
sequenceDiagram
    autonumber
    participant Q as Fila FIFO do canal
    participant C as SqsChannelConsumer
    participant DS as DeliverAlertService
    participant D as DLQ do canal

    C->>Q: ReceiveMessage (10 msgs)<br/>atributo MessageGroupId
    Q-->>C: mensagens
    Note over C: agrupa por MessageGroupId (accountId)<br/>mesmo grupo: em série<br/>grupos diferentes: em paralelo
    loop cada mensagem do grupo
        C->>C: parseAlert(body)
        alt ilegível ou sem campos mínimos
            C->>D: publish(POISON_MESSAGE, stage CHANNEL_DELIVERY)
            C->>Q: DeleteMessage
        else FraudAlert válido
            C->>DS: execute(alert, provider)
            DS-->>C: DELIVERED, ALREADY_DELIVERED ou DEAD_LETTERED
            C->>Q: DeleteMessage
        end
    end
    Note over C: falha de infraestrutura: log, métrica<br/>deliveries_total{infra_failure},<br/>mensagem volta à fila
```

A mensagem só é apagada depois de `DELIVERED`, `ALREADY_DELIVERED`, `DEAD_LETTERED` (já gravado na DLQ) ou da rejeição de uma mensagem veneno.

---

## 8. Entrega idempotente ao canal

`DeliverAlertService.execute` entrega o alerta a **um** canal. O `deliveryId` é estável (`deliveryIdOf(alertId, channel)`), então reentregas não duplicam o envio.

```mermaid
flowchart TD
    S([alert, provider]) --> ID[deliveryId = deliveryIdOf alertId, channel]
    ID --> REG[deliveries.register<br/>INSERT ON CONFLICT DO NOTHING<br/>e lê o status]
    REG --> ST{status}
    ST -- DELIVERED --> AD[/ALREADY_DELIVERED/]
    ST -- DEAD_LETTERED --> DL0[/DEAD_LETTERED/]
    ST -- PENDING --> BD[provider.buildDelivery<br/>startedAt = now]
    BD --> RT[retry com timeout e backoff<br/>provider.send delivery, alert]
    RT -- sucesso --> OK[deliveries.markDelivered<br/>deliveries_total delivered<br/>delivery_latency_ms]
    OK --> D1[/DELIVERED/]
    RT -- falha em uma tentativa --> RA[recordAttempt errorCode<br/>e tenta de novo]
    RA --> RT
    RT -- tentativas esgotadas --> DQ[publica na DLQ do canal<br/>MAX_RETRIES_EXCEEDED]
    DQ --> MD[deliveries.markDeadLettered<br/>métricas e log]
    MD --> D2[/DEAD_LETTERED/]
```

Os dois provedores são simulados e diferem no conteúdo enviado:

```mermaid
flowchart LR
    A[FraudAlert completo] --> AF[AntifraudQueueProvider<br/>audiência ANTIFRAUD_TEAM<br/>recebe o alerta completo]
    A --> PU[CustomerPushProvider<br/>audiência CUSTOMER<br/>template suspicious-transaction.v1]
    PU --> PC["só: tipo da transação, valor formatado,<br/>data e CONFIRM_OR_DISPUTE"]
    PU -. nunca .-> NO["regras, score, severidade,<br/>evidências"]
```

- `DELIVERY_TTL_MS` (10 min) define o `expiresAt` da entrega.
- Só lança em falha de infraestrutura (banco ou DLQ). Nesse caso o consumidor mantém a mensagem na fila para reentrega.
- A DLQ por canal é escolhida em `dlqQueues[channel]`; sem DLQ configurada, o serviço lança em vez de perder a mensagem.

---

## 9. Escritas no banco

Caminho feliz, para um alerta e os dois canais: **8 escritas de linha em 6 commits**.

```mermaid
sequenceDiagram
    autonumber
    participant S as ProcessTransactionService
    participant AR as AlertRepository
    participant DR as DeliveryRepository
    participant DB as Postgres

    rect rgb(235, 245, 255)
    Note over S,DB: Etapa 3: 1 transação, 2 escritas (no caminho medido pelo SLO)
    S->>AR: saveWithOutbox
    AR->>DB: BEGIN, INSERT alerts, INSERT outbox, COMMIT
    end
    rect rgb(240, 255, 240)
    Note over S,DB: Etapa 5: 1 transação, 2 escritas (depois de acceptedAt)
    S->>AR: markPublished (via publicador)
    AR->>DB: BEGIN, UPDATE outbox, UPDATE alerts, COMMIT
    end
    rect rgb(255, 248, 230)
    Note over DR,DB: Etapa 8: por canal, 2 escritas em autocommit (x2 canais)
    DR->>DB: INSERT deliveries (register) + SELECT status
    DR->>DB: UPDATE deliveries (markDelivered)
    end
```

| Situação | Escritas |
|---|---|
| Estorno, sem regra acionada, evento inválido (DLQ no SQS) | 0 |
| Alerta criado, caminho feliz | 2 (criação) + 2 (publicação) + 2 por canal (entrega) |
| Duplicata | 0 linhas (abre transação, `ROLLBACK`); +2 se completar a publicação pendente |
| Falha de publicação no SNS | +1 UPDATE em `outbox` por tentativa (`recordPublishFailure`) |
| Relay reivindicando uma linha | +1 UPDATE (lease em `next_attempt_at`), mais o `markPublished` se der certo |
| Falha de entrega num canal | +1 UPDATE em `deliveries` por tentativa que falhou; +1 no `markDeadLettered` se esgotar |

Só a etapa 3 está no caminho medido pelo SLO (`ingestedAt` até `acceptedAt`). O `markPublished` e as escritas de entrega ocorrem depois.

---

## 10. Garantias

| Garantia | Como o código a entrega |
|---|---|
| Sem perda silenciosa | A mensagem de entrada só é apagada após processar ou após a DLQ confirmar. O mesmo vale para a mensagem de cada canal. |
| Alerta nunca sem publicação pendente | Alerta e outbox são gravados na mesma transação; o relay republica o que ficou pendente. |
| Um alerta por transação | `dedupe_key` único no banco (`ON CONFLICT DO NOTHING`). |
| Sem duplicata no barramento | `MessageDeduplicationId = dedupeKey` no SNS FIFO. |
| Sem entrega duplicada ao canal | `deliveryId` estável com INSERT idempotente em `deliveries`. |
| Ordem por conta | `MessageGroupId = accountId` no SNS e processamento em série por grupo no consumidor do canal. |
| Isolamento entre canais | Um consumidor, filas e DLQs próprias por canal. |
| Dados sensíveis | Log e métricas da rejeição não carregam conteúdo do evento; o push ao cliente não leva regras, score nem severidade. |
| Rastreabilidade | `traceparent` propaga da mensagem de entrada ao outbox e ao SNS; `traceId` vai no alerta e nas entregas. |
