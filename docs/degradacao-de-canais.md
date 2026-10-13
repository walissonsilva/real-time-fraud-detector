# Degradação na entrega de alertas: circuit breaker, fallback e adiamento

Como a entrega de alertas se comporta quando um canal falha. Decisão e justificativas: [ADR-05](adr/ADR-05-estrategia-de-degradacao.md#adendo-2026-10-12-circuit-breaker-fallback-de-canal-e-kill-switch-implementados). Código: `src/deliveries/deliver-alert.service.ts`, `src/deliveries/sqs-channel.consumer.ts`, `src/shared/circuit-breaker.ts`. Fluxo geral do pipeline: [fluxo-processamento.md](fluxo-processamento.md).

**Premissa central:** a detecção e a geração do alerta nunca dependem da entrega. Tudo abaixo acontece depois que o alerta já está gravado (Postgres + outbox) e publicado; uma falha de canal só afeta a entrega daquele canal.

## 1. Visão geral: o que acontece com uma mensagem de entrega

```mermaid
flowchart TD
    Q[(Fila FIFO do canal)] --> C[Consumidor do canal]
    C --> E{DeliverAlertService.execute}
    E -->|já DELIVERED ou FALLBACK_DELIVERED| DEL[Apaga a mensagem]
    E -->|já DEAD_LETTERED| DEL
    E -->|entregou pelo canal primário| OK[DELIVERED]
    E -->|primário falhou, alternativo entregou| FB[FALLBACK_DELIVERED]
    E -->|sem entrega e breaker aberto, alerta válido| DF[DEFERRED]
    E -->|retries esgotados com breaker fechado| DLQ1[DLQ: MAX_RETRIES_EXCEEDED]
    E -->|sem entrega e alerta vencido, 10 min| DLQ2[DLQ: DELIVERY_EXPIRED]
    E -->|banco ou DLQ indisponível| INF[Falha de infraestrutura]
    OK --> DEL
    FB --> DEL
    DLQ1 --> DEL
    DLQ2 --> DEL
    DF --> VIS[Mantém a mensagem e ajusta a visibilidade<br/>para o fim do cooldown]
    INF --> KEEP[Mantém a mensagem; volta após o<br/>visibility timeout de 30 s]
    VIS --> Q
    KEEP --> Q
```

| Resultado | Quem apaga a mensagem | Vai à DLQ? | Linha em `deliveries` |
|---|---|---|---|
| `DELIVERED` | consumidor | não | `DELIVERED` |
| `FALLBACK_DELIVERED` | consumidor | não | push `FALLBACK_DELIVERED`, SMS `DELIVERED` |
| `DEFERRED` | ninguém (volta à fila) | não | `PENDING` |
| `DEAD_LETTERED` | consumidor | sim | `DEAD_LETTERED` |
| falha de infraestrutura | ninguém (volta à fila) | não | inalterada |

## 2. Máquina de estados do circuit breaker

Um breaker por canal (`ANTIFRAUD_QUEUE`, `PUSH`, `SMS`), com estado em memória, por task.

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> CLOSED: sucesso (zera a contagem de falhas)
    CLOSED --> OPEN: N falhas consecutivas<br/>(CHANNEL_BREAKER_FAILURE_THRESHOLD, padrão 5)
    OPEN --> OPEN: chamada recusada na hora<br/>(CircuitOpenError, sem tocar o provedor)
    OPEN --> HALF_OPEN: passou CHANNEL_BREAKER_OPEN_MS (30 s)<br/>e chegou uma chamada
    HALF_OPEN --> CLOSED: a sonda teve sucesso
    HALF_OPEN --> OPEN: a sonda falhou (reinicia os 30 s)
    HALF_OPEN --> HALF_OPEN: demais chamadas recusadas<br/>enquanto a sonda está em voo
    CLOSED --> FORCED_OPEN: kill switch (CHANNEL_*_DISABLED=true)
    OPEN --> FORCED_OPEN: kill switch
    FORCED_OPEN --> CLOSED: kill switch desligado
    note right of FORCED_OPEN
        Aparece como OPEN no gauge.
        Não gera sondas: recusa tudo
        até o switch ser desligado.
    end note
```

Valores do gauge `circuit_breaker_state{channel}`: `0` fechado, `1` meio-aberto, `2` aberto (inclui o kill switch).

## 3. Decisão por entrega (dentro do `execute`)

```mermaid
flowchart TD
    A[Recebe alerta + provedor] --> R[register: cria linha PENDING<br/>ou lê o status atual]
    R --> S1{status}
    S1 -->|DELIVERED| X1[ALREADY_DELIVERED]
    S1 -->|FALLBACK_DELIVERED| X2[FALLBACK_DELIVERED]
    S1 -->|DEAD_LETTERED| X3[DEAD_LETTERED]
    S1 -->|PENDING| P[Envia pelo canal primário<br/>até 3 tentativas, timeout 2 s, backoff com jitter]
    P --> B1{breaker do primário}
    B1 -->|aberto| FF[Falha rápida: sem espera,<br/>sem tocar o provedor]
    B1 -->|fechado ou sonda| SEND[provider.send]
    SEND -->|sucesso| MD[markDelivered → DELIVERED]
    SEND -->|falha ou timeout| RT{tentativas restantes<br/>e breaker ainda admite?}
    RT -->|sim| P
    RT -->|não| FALL
    FF --> FALL{o canal tem fallback?<br/>só o PUSH tem: SMS}
    FALL -->|não| DEC
    FALL -->|sim| SD{SMS já DELIVERED?}
    SD -->|sim| MF[markFallbackDelivered no push]
    SD -->|não| SS[Envia pelo SMS<br/>com o breaker e o retry do SMS]
    SS -->|sucesso| REG[register + markDelivered do SMS] --> MF
    SS -->|falha| DEC
    MF --> X2
    DEC{algum breaker<br/>primário/fallback não está CLOSED?}
    DEC -->|sim| EXP{alerta vencido?<br/>detectedAt + 10 min}
    DEC -->|não| EXP2{alerta vencido?}
    EXP -->|não| DF[DEFERRED: adia, sem DLQ]
    EXP -->|sim| DX[DLQ: DELIVERY_EXPIRED<br/>markDeadLettered]
    EXP2 -->|não| DM[DLQ: MAX_RETRIES_EXCEEDED<br/>markDeadLettered]
    EXP2 -->|sim| DX
```

## 4. Cenários

### Resumo

| # | Cenário | Canal | Resultado | DLQ? | Visível em |
|---|---|---|---|---|---|
| A | Tudo saudável | todos | `DELIVERED` | não | `DeliveriesDelivered` |
| B | Falha transitória do provedor | qualquer | `DELIVERED` após retry | não | tentativas em `deliveries.attempts` |
| C | Push fora, SMS saudável | cliente | `FALLBACK_DELIVERED` | não | `DeliveriesFallback`, `BreakerPush` = 2 |
| D | Push e SMS fora, breaker abre | cliente | `DEFERRED`, depois `DELIVERED` | não | `DeliveriesDeferred`, `BreakerPush/Sms` = 2 |
| E | Antifraude fora | interno | `DEFERRED`; se passar de 10 min, DLQ `DELIVERY_EXPIRED` | só se vencer | `BreakerAntifraud` = 2, `DeliveriesDeferred` |
| F | Retries esgotados com breaker ainda fechado | qualquer | `DEAD_LETTERED` (`MAX_RETRIES_EXCEEDED`) | sim | `DeliveriesDeadLettered`, `DlqMessages` |
| G | Kill switch ligado | qualquer | push → SMS; os demais `DEFERRED` | só se vencer | gauge em 2 sem falhas |
| H | Banco ou DLQ indisponível durante a entrega | qualquer | mensagem volta à fila | não | `DeliveriesInfraFailure` |
| I | Queda entre enviar o SMS e marcar o push | cliente | reentrega sem duplicar o SMS | não | `FALLBACK_DELIVERED` |
| J | Recuperação com mensagens acumuladas | qualquer | drena pela sonda | não | breaker volta a 0 |

### A. Tudo saudável

```mermaid
sequenceDiagram
    participant Q as Fila do canal
    participant C as Consumidor
    participant S as DeliverAlertService
    participant P as Provedor
    participant DB as deliveries
    Q->>C: mensagem (FraudAlert)
    C->>S: execute(alert, provider)
    S->>DB: register → PENDING
    S->>P: send (breaker CLOSED)
    P-->>S: ok
    S->>DB: markDelivered
    S-->>C: DELIVERED
    C->>Q: DeleteMessage
```

### B. Falha transitória do provedor

Uma ou duas falhas seguidas são absorvidas pelo retry; o breaker só abre com falhas **consecutivas** acima do limiar, e um sucesso zera a contagem.

```mermaid
sequenceDiagram
    participant S as DeliverAlertService
    participant B as Breaker (CLOSED)
    participant P as Provedor
    S->>B: tentativa 1
    B->>P: send
    P--xB: erro / timeout 2 s
    Note over B: falhas consecutivas = 1
    S->>S: espera backoff com jitter
    S->>B: tentativa 2
    B->>P: send
    P-->>B: ok
    Note over B: falhas consecutivas = 0
    S-->>S: DELIVERED
```

### C. Push fora, SMS saudável (fallback)

```mermaid
sequenceDiagram
    participant C as Consumidor (PUSH)
    participant S as DeliverAlertService
    participant BP as Breaker PUSH
    participant PU as Push
    participant BS as Breaker SMS
    participant SM as SMS
    participant DB as deliveries
    C->>S: execute(alert, push)
    S->>DB: register(push) → PENDING
    loop até 3 tentativas
        S->>BP: exec
        BP->>PU: send
        PU--xBP: indisponível
    end
    Note over BP: com falhas acumuladas o breaker abre<br/>e as próximas chamadas falham sem espera
    S->>DB: isDelivered(sms)? não
    S->>BS: exec
    BS->>SM: send
    SM-->>BS: ok
    S->>DB: register(sms) + markDelivered(sms)
    S->>DB: markFallbackDelivered(push)
    S-->>C: FALLBACK_DELIVERED
    C->>C: DeleteMessage
```

- O SMS usa `deliveryId = sha256("alert-delivery:v1:" + alertId + ":SMS")`, com o mesmo conteúdo mínimo do push (tipo, valor, data, orientação), sem PII adicional.
- Com o breaker do push **aberto**, cada novo alerta pula o push na hora (sem os ~2 s de timeout × 3) e vai direto ao SMS.
- A linha do SMS só é criada quando ele entrega, para não deixar entrega `PENDING` órfã.

### D. Push e SMS fora: adiamento e recuperação

```mermaid
sequenceDiagram
    participant Q as Fila do push
    participant C as Consumidor
    participant S as DeliverAlertService
    participant BP as Breaker PUSH
    participant BS as Breaker SMS
    Q->>C: mensagem
    C->>S: execute
    S->>BP: tentativas falham → breaker OPEN
    S->>BS: SMS falha → breaker OPEN
    S-->>C: DEFERRED (alerta ainda válido)
    C->>Q: ChangeMessageVisibility = tempo até reabrir (1 a 300 s)
    Note over Q,C: sem DLQ; a mensagem não é apagada
    Note over BP: após 30 s: HALF_OPEN
    Q->>C: mensagem reaparece
    C->>S: execute
    S->>BP: sonda
    alt provedor voltou
        BP-->>S: sucesso → CLOSED
        S-->>C: DELIVERED
        C->>Q: DeleteMessage
    else ainda fora
        BP-->>S: falha → OPEN por mais 30 s
        S-->>C: DEFERRED de novo
    end
```

Enquanto durar a queda, o ciclo se repete a cada ~30 s por mensagem. Na recuperação, a fila drena sem redrive manual e sem passar pela DLQ.

### E. Antifraude fora (sem fallback)

O contrato proíbe cliente em canal interno e vice-versa, então o canal antifraude não tem alternativa: só adia.

```mermaid
flowchart LR
    A[Antifraude indisponível] --> B[Breaker ANTIFRAUD abre]
    B --> C[Mensagens DEFERRED<br/>voltam a cada ~30 s]
    C --> D{alerta com mais de 10 min?}
    D -->|não| E{provedor voltou?}
    E -->|sim| F[Sonda ok → DELIVERED<br/>fila drena]
    E -->|não| C
    D -->|sim| G[DLQ DELIVERY_EXPIRED<br/>reprocesso manual]
```

Os canais do cliente seguem normalmente: cada canal tem fila, consumidor e breaker próprios (bulkhead).

### F. Retries esgotados com o breaker ainda fechado

Ocorre quando as tentativas de **um** alerta acabam antes do limiar de falhas consecutivas (padrão: 3 tentativas contra limiar 5). É tratado como falha daquele alerta, não do canal inteiro:

```mermaid
flowchart LR
    A[3 tentativas falharam<br/>falhas consecutivas = 3 &lt; 5] --> B[Breaker segue CLOSED]
    B --> C[Sem fallback que entregue]
    C --> D[DLQ do canal: MAX_RETRIES_EXCEEDED<br/>linha DEAD_LETTERED]
```

Consequência assumida: o **primeiro** alerta de uma queda pode ir à DLQ; a partir do seguinte as falhas acumuladas abrem o breaker e as mensagens passam a ser adiadas.

### G. Kill switch

`CHANNEL_ANTIFRAUD_DISABLED`, `CHANNEL_CUSTOMER_DISABLED` ou `CHANNEL_SMS_DISABLED` = `true` força o breaker do canal aberto, sem falha prévia.

```mermaid
flowchart TD
    K[Kill switch ligado] --> W{canal desligado}
    W -->|PUSH| P[Push recusado na hora] --> SM[Entrega direto pelo SMS<br/>FALLBACK_DELIVERED]
    W -->|SMS| S[Push segue normal;<br/>se o push também falhar, DEFERRED]
    W -->|ANTIFRAUD| A[Entregas DEFERRED<br/>revalidadas a cada 30 s]
    W -->|PUSH e SMS| PS[Cliente DEFERRED]
    A --> V{passou de 10 min?}
    PS --> V
    V -->|sim| D[DLQ DELIVERY_EXPIRED]
    V -->|não| R[Aguardando o switch ser desligado]
    R -->|switch desligado| OK[Reentrega normal e fila drena]
```

Na AWS é variável do serviço ECS: muda-se o valor no `ecs.tf` e roda-se `terraform apply` (rolling update de ~2 min, sem build nem deploy de código). Não há sondas enquanto o switch está ligado.

### H. Falha de infraestrutura (Postgres ou DLQ)

Se o Postgres, o registro da entrega ou a publicação na DLQ falham, `execute` lança. O consumidor não apaga a mensagem; ela volta após o visibility timeout (30 s) e é reprocessada de forma idempotente (`deliveryId` estável + `register` com `ON CONFLICT DO NOTHING`). Conta em `DeliveriesInfraFailure`; o alarme de DLQ não dispara, mas o de idade da fila do canal sim, se persistir.

### I. Queda entre enviar o SMS e marcar o push

```mermaid
sequenceDiagram
    participant S as DeliverAlertService
    participant SM as SMS
    participant DB as deliveries
    S->>SM: send → ok
    S->>DB: register(sms) + markDelivered(sms)
    Note over S: a task cai aqui, antes de markFallbackDelivered(push)
    Note over S: mensagem volta à fila (push ainda PENDING)
    S->>S: reentrega: push falha de novo
    S->>DB: isDelivered(sms)? sim
    S->>DB: markFallbackDelivered(push)
    Note over S,SM: o SMS não é reenviado
```

Janela residual: se a queda ocorrer **depois** do SMS e o push voltar a funcionar na reentrega, o cliente pode receber push e SMS. É preferível ao risco oposto (não notificar).

### J. Recuperação com acúmulo

Com N mensagens adiadas, cada uma volta à fila no fim do próprio cooldown. A primeira que chega ao breaker meio-aberto vira a **sonda**; as demais, enquanto a sonda está em voo, são recusadas e adiadas por ~1 s. Com a sonda bem-sucedida, o breaker fecha e a fila drena na velocidade normal do consumidor. Ordem por conta (grupo FIFO) preservada: uma mensagem adiada segura as seguintes do mesmo grupo.

## 5. Como observar

| Sinal | Onde | Leitura |
|---|---|---|
| `circuit_breaker_state{channel}` | `/metrics`, `BreakerAntifraud/Push/Sms` no CloudWatch | 0 fechado, 1 meio-aberto, 2 aberto ou kill switch |
| `circuit_breaker_transitions_total{channel,to}` | `/metrics`, logs `circuit breaker do canal mudou de estado` | frequência de abertura/fechamento |
| `deliveries_total{status="fallback"}` | `DeliveriesFallback` | alertas que saíram pelo SMS |
| `deliveries_total{status="deferred"}` | `DeliveriesDeferred` | entregas adiadas por breaker aberto |
| `deliveries_total{status="dead_lettered"}`, `dlq_total` | `DeliveriesDeadLettered`, `DlqMessages`, alarme de DLQ | o que exige reprocesso |
| idade da fila do canal | `AWS/SQS ApproximateAgeOfOldestMessage` | acúmulo durante a queda |

Dashboard `<nome>-operacao`: widgets *Circuit breaker por canal* e *Fallback e entregas adiadas* (linha 6).

## 6. Parâmetros

| Variável | Padrão | Efeito |
|---|---|---|
| `CHANNEL_DELIVERY_MAX_ATTEMPTS` | 3 | tentativas por entrega, por canal |
| `CHANNEL_DELIVERY_BASE_DELAY_MS` / `_MAX_DELAY_MS` | 200 / 2000 | backoff exponencial com jitter total |
| `CHANNEL_SEND_TIMEOUT_MS` | 2000 | limite por tentativa |
| `CHANNEL_BREAKER_FAILURE_THRESHOLD` | 5 | falhas consecutivas que abrem o breaker |
| `CHANNEL_BREAKER_OPEN_MS` | 30000 | tempo aberto antes da sonda |
| `CHANNEL_*_DISABLED` | `false` | kill switch do canal |
| `CHANNEL_*_FAIL` | `false` | injeção de falha no provedor simulado (demonstração e testes) |
| validade do alerta | 10 min | `detectedAt` + `DELIVERY_TTL_MS`; passado disso, DLQ `DELIVERY_EXPIRED` |

## 7. Limites assumidos

- **Estado por task:** cada instância aprende sozinha; no pior caso, 3 tasks × 5 falhas até todas abrirem. Estado compartilhado (Redis) é evolução.
- **Kill switch não é instantâneo:** exige rolling update do serviço. Corte imediato exigiria um perfil de feature flag no AppConfig.
- **Alerta vencido vai à DLQ:** queda do antifraude por mais de 10 min leva os alertas à DLQ para reprocesso manual.
- **Primeiro alerta de uma queda:** pode ir à DLQ antes de o breaker abrir (cenário F).
- **Fallback só push → SMS:** não há e-mail nem outra alternativa para o canal interno.
