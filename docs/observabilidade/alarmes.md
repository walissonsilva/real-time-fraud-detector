# Alarmes

Todos os alarmes publicam no tópico SNS `fraud-detector-ops-alerts`, com assinatura por e-mail (`alert_email`). Cada seção abaixo diz **o que dispara**, **por quê** e **onde olhar primeiro**. O orçamento mensal tem avisos próprios (80% real e 100% previsto).

## Resumo

| Alarme | Dispara quando | Sinal de |
|---|---|---|
| `dlq-transactions-not-empty`, `dlq-antifraud-not-empty`, `dlq-customer-not-empty` | Qualquer mensagem visível na DLQ (1 min) | Falha que ninguém tratou |
| `transactions-oldest-message-age` | Mensagem mais antiga com mais de 60 s por 3 min | Consumo atrasado |
| `alert-latency-p99-high` | p99 do alerta acima de 500 ms em 2 janelas de 5 min | **SLO violado** |
| `outbox-oldest-pending-high` | Alerta pendente no outbox há mais de 30 s por 2 min | Alerta gravado, mas não publicado |
| `ecs-cpu-high` | CPU média do ECS acima de 85% por 5 min | Saturação |
| `rds-cpu-high` | CPU média do RDS acima de 80% por 5 min | Saturação do banco |
| `rds-free-storage-low` | Menos de 5 GiB livres | Falta de espaço |
| `ecs-running-below-desired` | Tasks abaixo do mínimo por 3 min | Indisponibilidade |
| `rules-refresh-stale` | Última atualização das regras há mais de 90 s | AppConfig inacessível |
| `rules-refresh-failures` | Falhas de refresh em 2 de 3 minutos | Documento rejeitado ou AppConfig fora |
| `rules-revision-diverged` | Instâncias em revisões diferentes por 20 min | Rollout travado |
| `rules-alert-rate-anomaly` | Taxa de alertas fora da faixa esperada | Regra com falso positivo ou que deixou de pegar fraude |
| `rules-rollback` (composto) | Qualquer um de uma lista de sinais | Aciona o rollback automático das regras |

## Alarmes de saúde do pipeline

### DLQs não vazias

- **Condição:** `ApproximateNumberOfMessagesVisible` > 0 em qualquer uma das três DLQs, avaliada a cada minuto.
- **Por que:** uma mensagem na DLQ é um evento ou entrega que esgotou as tentativas. O sistema não a reprocessa sozinho.
- **Onde olhar:** widget *DLQs* do dashboard; depois o corpo da `DlqMessage` (campo de estágio e motivo), que diz se foi validação, banco ou entrega.
- **Por que 0 como limite:** não existe DLQ "um pouco cheia". Qualquer valor é falha.

### Backlog em `transactions`

- **Condição:** `ApproximateAgeOfOldestMessage` > 60 s por 3 minutos seguidos.
- **Por que:** é o sinal mais direto de que o consumo não acompanha a entrada. A idade, diferente da quantidade, não depende do volume.
- **Onde olhar:** *Vazão: entrada × consumo* e *Backlog da fila*. Se a CPU do ECS está alta, falta capacidade; se está baixa, o gargalo é I/O (banco, SNS).

### Latência do alerta (SLO)

- **Condição:** p99 de `AlertLatencyMs` acima de 500 ms em **2 janelas de 5 min seguidas**.
- **Detalhe importante:** com menos de **20 alertas** na janela, o alarme usa 0. Em tráfego baixo, um único alerta lento não deve disparar o SLO.
- **Por que p99 e não média:** a média esconde a cauda; o SLO é sobre o pior 1%.
- **Onde olhar:** widget *Latência do alerta*; depois *Backlog* (espera na fila) e *RDS* (escrita lenta).

### Outbox parado

- **Condição:** `OutboxOldestPendingAgeMs` > 30 s por 2 minutos.
- **Por que:** o alerta existe no banco, mas não saiu para o SNS. O relay tenta a cada 1 s, então 30 s pendente indica relay, SNS ou banco com problema.
- **Onde olhar:** widget *Outbox*: pendentes, idade do mais antigo e falhas de publicação.

## Alarmes de capacidade

| Alarme | Limite | Observação |
|---|---|---|
| `ecs-cpu-high` | média > 85% por 5 min | O autoscaling mira 60%; chegar a 85% sugere que escalar não está dando conta ou atingiu o máximo de tasks |
| `rds-cpu-high` | média > 80% por 5 min | Nos testes, o RDS ficou em 8% (1.000 TPS) e 16% (4.000 TPS) |
| `rds-free-storage-low` | mínimo < 5 GiB | O armazenamento tem autoscaling até 4×, então este alarme avisa antes de bater o teto |
| `ecs-running-below-desired` | mínimo de tasks < `service_min_count` por 3 min | Só existe com Container Insights ligado; sem dados, **conta como violação** |

## Alarmes das regras dinâmicas

| Alarme | Condição | Por quê |
|---|---|---|
| `rules-refresh-stale` | `RulesLastRefreshAgeSeconds` > 90 s por 3 min | O SLO de frescor é 30 s; 90 s tolera três ciclos de consulta perdidos |
| `rules-refresh-failures` | `RulesRefreshFailures` > 0 em 2 de 3 min | Cobre documento rejeitado pelas instâncias e AppConfig fora |
| `rules-revision-diverged` | `RulesActiveRevision` máx. − mín. > 0 por 20 min | Um rollout normal dura 10 min + 5 de bake; 20 min significa travado |
| `rules-alert-rate-anomaly` | `AlertsCreated` fora da faixa de anomalia (3 desvios), 4 de 5 min | Uma regra nova pode ter disparado falsos positivos ou parado de pegar fraude |

O alarme de anomalia usa um modelo que **aprende com histórico**: no início é pouco sensível.

## Alarme composto de rollback

`rules-rollback` é um **gatilho de ação**, não um aviso por e-mail. Ele é o monitor do ambiente do AppConfig: se estiver em ALARM durante um rollout ou bake, o AppConfig reverte o deployment sozinho.

Entra nele (qualquer um, em OR):

- as três DLQs não vazias;
- backlog em `transactions`;
- `rules-refresh-failures`;
- `rules-alert-rate-anomaly`.

Ficam **de fora** de propósito `alert-latency-p99-high` e `outbox-oldest-pending-high`: as causas incluem SNS, banco e carga, e reverter regras por isso seria a ação errada. A reversão foi validada na AWS em cerca de 1 s após o alarme (cenário 4 do [registro de testes](../registro-testes-aws.md)).

## O que não é alarmado

- **Circuit breaker aberto**: aparece no dashboard, sem alarme.
- **Disponibilidade mensal (99,95%)**: não é medida como SLO.
- **Burn rate** do SLO de latência.
- **Latência por etapa**: o alarme de SLO diz *que* passou de 500 ms, não *onde* o tempo foi gasto.
- **Redis**: tem widget, mas nenhum alarme (e hoje não é usado pelo código de negócio).
