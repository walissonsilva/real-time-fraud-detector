# Métricas

Duas famílias: as que **a aplicação emite** (namespaces `FraudDetector/*`) e as **nativas da AWS** usadas pelos alarmes e pelo dashboard.

## Como uma métrica nasce

A cada **60 s** a aplicação escreve duas linhas JSON no stdout (`pipeline.metrics` e `rules.metrics`). O driver `awslogs` as envia ao CloudWatch Logs e um *metric filter* extrai cada campo como uma métrica. Duas regras de leitura:

- **Contador** (por exemplo `EventsAlerted`): o valor é o **delta do último minuto**. Use `Sum` para ver quantos eventos ocorreram.
- **Gauge** (por exemplo `OutboxPending`): o valor é o **estado naquele instante**. Use `Maximum` (ou `Minimum`) para pegar o pior caso entre as tasks.

> As métricas não têm dimensões nem identificador de task. Isso evita alta cardinalidade e PII, mas significa que o valor é **agregado entre as instâncias**: um problema em uma só task aparece diluído no `Sum` e visível no `Maximum` dos gauges.

Há ainda `GET /metrics` em formato Prometheus, por instância, útil no ambiente local e para depuração. A visão agregada vem do CloudWatch.

## `FraudDetector/Pipeline`: o caminho da transação ao alerta

### Eventos processados

Cada transação consumida de `transactions` termina em exatamente um destes resultados.

| Métrica | Tipo | O que significa |
|---|---|---|
| `EventsAlerted` | contador | Transação suspeita: alerta criado e gravado |
| `EventsNoAlert` | contador | Transação avaliada e considerada normal (inclui estornos ignorados) |
| `EventsDuplicate` | contador | Evento já visto; reavaliar produziu a mesma decisão |
| `EventsRejected` | contador | Evento inválido, enviado à DLQ de entrada |
| `EventsTransientFailure` | contador | Falha temporária (banco, SNS); a mensagem volta à fila para nova tentativa |

Como ler: `EventsNoAlert` deve dominar; a taxa de `EventsAlerted` fica perto da taxa de alertas do perfil (1% nos testes). Um `EventsTransientFailure` constante indica dependência instável.

### Latência do alerta

| Métrica | Tipo | O que significa |
|---|---|---|
| `AlertLatencyMs` | amostras em ms | Tempo de `ingestedAt` (entrada no SQS) até o **aceite do SNS**, uma amostra por alerta |

É a métrica do SLO de 500 ms. Use as estatísticas `p50`, `p95`, `p99` e `SampleCount`. Ela soma espera na fila, processamento, gravação e publicação: o número é único e **não** separa as etapas.

### Outbox

O alerta é gravado junto com uma linha de *outbox* e depois publicado no SNS; um relay republica o que ficou pendente.

| Métrica | Tipo | O que significa |
|---|---|---|
| `OutboxPending` | gauge | Alertas gravados que ainda não saíram para o SNS |
| `OutboxOldestPendingAgeMs` | gauge | Há quanto tempo o mais antigo está pendente (ms) |
| `OutboxPublishFailures` | contador | Falhas de publicação inline no SNS |
| `OutboxRepublished` | contador | Alertas que o relay precisou republicar |

Como ler: pendentes perto de 0 e idade de poucos ms é o normal. `OutboxRepublished` subindo mostra que a publicação inline está falhando e o relay está salvando o dia.

### Entregas por canal

| Métrica | Tipo | O que significa |
|---|---|---|
| `DeliveriesDelivered` | contador | Entregas concluídas |
| `DeliveriesDeadLettered` | contador | Esgotaram as retentativas e foram para a DLQ do canal |
| `DeliveriesInfraFailure` | contador | Falha de infraestrutura ao entregar |
| `DeliveriesFallback` | contador | Entregues pelo canal alternativo (push → SMS) |
| `DeliveriesDeferred` | contador | Adiadas (breaker aberto ou canal desligado) |

### Circuit breakers

| Métrica | Tipo | Valores |
|---|---|---|
| `BreakerAntifraud`, `BreakerPush`, `BreakerSms` | gauge | `0` fechado (normal), `1` meio-aberto (testando), `2` aberto (canal isolado) |

O dashboard mostra o **máximo entre as tasks**: basta uma task com o breaker aberto para o valor ser 2. Fluxo completo em [degradacao-de-canais.md](../degradacao-de-canais.md).

### DLQ

| Métrica | Tipo | O que significa |
|---|---|---|
| `DlqMessages` | contador | Mensagens que a aplicação enviou a alguma DLQ no minuto |

Complementa a métrica nativa do SQS: esta conta o **envio**, a nativa mostra o **estoque** acumulado.

## `FraudDetector/Rules`: regras dinâmicas

| Métrica | Tipo | O que significa |
|---|---|---|
| `RulesActiveRevision` | gauge | Revisão de regras ativa (carimbo `AAAAMMDDhhmmss`) |
| `RulesLastRefreshAgeSeconds` | gauge | Segundos desde a última consulta bem-sucedida ao AppConfig |
| `RulesRefreshFailures` | contador | Falhas ao consultar ou ativar as regras |
| `AlertsCreated` | contador | Alertas criados no minuto (base da taxa e da faixa de anomalia) |

Como ler: com tudo normal, `RulesActiveRevision` tem o mesmo valor em máximo e mínimo. Se os dois divergem, há instâncias em revisões diferentes (rollout em andamento ou travado).

## `FraudDetector/LoadTest`: marcadores de teste

Gravadas pelo `loadtest.sh` durante os testes de carga, não pela aplicação.

| Métrica | O que significa |
|---|---|
| `PlannedTps` | TPS planejado da etapa em curso |
| `Phase` | `1` aquecimento, `2` sustentado, `3` drain |

## Métricas nativas da AWS usadas

| Serviço | Métricas | Para quê |
|---|---|---|
| SQS | `NumberOfMessagesSent`, `NumberOfMessagesDeleted` | TPS de entrada e de consumo |
| SQS | `ApproximateNumberOfMessagesVisible`, `…NotVisible` | Backlog e mensagens em voo |
| SQS | `ApproximateAgeOfOldestMessage` | Idade do backlog (filas de entrada e de canal) |
| ECS | `CPUUtilization`, `MemoryUtilization` | Saturação do serviço |
| ECS Container Insights | `RunningTaskCount`, `DesiredTaskCount` | Tasks rodando × desejadas |
| RDS | `CPUUtilization`, `DatabaseConnections`, `WriteIOPS`, `WriteLatency`, `FreeStorageSpace` | Saúde e capacidade do banco |
| ElastiCache | `EngineCPUUtilization`, `CurrConnections` | Saúde do Redis (hoje sem uso pelo código de negócio) |

## Atrasos e limitações

- As métricas do SQS e do RDS chegam ao CloudWatch com **1 a 5 min de atraso**. Para números finais de um teste, vale o relatório do k6.
- `AlertLatencyMs` não decompõe a latência por etapa (fila, regras, banco, publicação). Ver a lacuna registrada em [Alarmes](alarmes.md#o-que-não-é-alarmado).
