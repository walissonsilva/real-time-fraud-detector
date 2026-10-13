# ADR-08 — Observabilidade, SLOs e resposta a incidentes

> Status: **aceito**; alertas por *burn rate*, *runbooks* e tracing distribuído **não implementados** · Data: 12/10/2026 (alarmes de latência e de *outbox* aplicados em 13/10/2026) · Relacionada: [ADR-03](ADR-03-motor-de-regras.md), [ADR-05](ADR-05-estrategia-de-degradacao.md) · Requisitos: RNF-03, RNF-10, RNF-40 a RNF-47, RF-52

## Contexto

O enunciado pede "monitoramento operacional (SRE) e resposta a incidentes". O serviço roda em ECS Fargate, sem *sidecar* de coleta, e a decisão de instrumentação precisava funcionar igual no ambiente local (sem CloudWatch) e na AWS.

## Decisão

### Instrumentação: logs JSON e métricas em memória, publicadas por linha de log

- **Logs estruturados** (JSON, uma linha por evento) com `traceId`, `transactionId`, `alertId` e `deliveryId`; PII redigida por lista de chaves (ADR-07). O `traceparent` W3C entra como atributo da mensagem SQS e é propagado até o alerta e as entregas, de modo que um alerta é rastreável de ponta a ponta por um único `traceId`.
- **Métricas em memória** (`InMemoryMetrics`), expostas em `GET /metrics` em formato Prometheus, e as mesmas publicadas como **linhas de log** (`pipeline.metrics`, `rules.metrics`, `alert.published`) que **filtros de métrica do CloudWatch** transformam em métricas nos *namespaces* `FraudDetector/Pipeline` e `FraudDetector/Rules`. O `/metrics` é por instância e serve ao ambiente local e à depuração; a visão agregada vem do CloudWatch.
- **Por que linhas de log e não EMF, OpenTelemetry ou Prometheus gerenciado:** não exige agente nem *sidecar*, funciona com o driver `awslogs` já usado e a extração por EMF não pôde ser confirmada no ambiente (registrado no ADR-03). O custo é a latência de agregação do CloudWatch (~1 min) e uma lista de filtros mantida em Terraform.

### SLIs e SLOs

| SLO | Meta | SLI e fonte | Situação |
|-----|------|-------------|----------|
| Latência do alerta | p99 ≤ 500 ms (p95 ≤ 300 ms) | `AlertLatencyMs` = aceite no SNS − `ingestedAt` (`SentTimestamp` do SQS). Por log `alert.published`, estatística p99 | **Medido, exibido e alarmado** (alarme `alert-latency-p99-high`) |
| Latência e2e (visão do usuário) | informativa | `alert_e2e_latency_ms` do k6, só em teste de carga (inclui envio e fan-out SNS → SQS) | Medido nos testes |
| *Freshness* das regras | ≤ 30 s na distribuição final | `rules_last_refresh_age_seconds` por instância | **Alarme** em 90 s (3 min de avaliação) |
| Entrega sem perda | 0 alertas perdidos ou duplicados | Alertas esperados × recebidos × únicos no teste; DLQs vazias | Verificado nos testes (0 duplicados a 1.000 TPS) |
| Backlog | idade da mensagem mais antiga em `transactions` < 60 s | `ApproximateAgeOfOldestMessage` | **Alarme** (3 min acima de 60 s) |
| Disponibilidade do pipeline | 99,95% mensal (RNF-10) | Eventos processados no prazo ÷ recebidos | **Não medida como SLO**; só há os componentes (backlog, DLQ, tasks) |

### Alarmes e roteamento

Todos os alarmes publicam em um tópico SNS (`<nome>-ops-alerts`) com assinatura por e-mail.

| Alarme | Condição | Sinal de |
|--------|----------|----------|
| `dlq-*-not-empty` (uma por DLQ) | Qualquer mensagem visível, 1 min | Falha que exige reprocesso (ADR-05) |
| `transactions-oldest-message-age` | > 60 s por 3 min | Consumo atrasado |
| `ecs-cpu-high` / `rds-cpu-high` | CPU > 85% / 80% por 5 min | Saturação (USE) |
| `rds-free-storage-low` | < 5 GiB | Capacidade |
| `ecs-running-below-desired` | Tasks abaixo do mínimo por 3 min | Indisponibilidade |
| `alert-latency-p99-high` | p99 de `AlertLatencyMs` > 500 ms em 2 janelas de 5 min, com ao menos 20 alertas na janela (senão, ignora) | **SLO de latência violado** |
| `outbox-oldest-pending-high` | Entrada pendente no *outbox* há mais de 30 s por 2 min | Relay, SNS ou banco impedindo a publicação (ADR-04) |
| `rules-refresh-stale`, `rules-refresh-failures`, `rules-revision-diverged`, `rules-alert-rate-anomaly` | Regras desatualizadas, falhas de refresh, instâncias em revisões diferentes por N min, taxa de alertas fora da faixa | Saúde das regras (ADR-03) |
| `rules-rollback` (composto) | DLQs, backlog, falhas de refresh ou taxa anômala | **Aciona o rollback automático** do AppConfig |
| Orçamento | 80% e 100% | Custo |

Os dois alarmes de latência e de *outbox* **não** entram no alarme composto de rollback: suas causas incluem SNS, banco e carga, e reverter regras por isso seria a ação errada. O alarme composto liga observabilidade a ação: uma regra ruim publicada que degrade o pipeline é revertida sem intervenção (validado na AWS, cenário 4 do [registro](../registro-testes-aws.md)).

### Dashboard

`<nome>-operacao` no CloudWatch: linha de saúde (p99 do alerta contra o SLO de 500 ms, TPS, idade da fila, DLQs, tasks, alarmes), vazão entrada × consumo, backlog, eventos por resultado, taxa de alertas e faixa esperada, *outbox*, entregas por canal, DLQs, ECS, RDS, Redis, regras dinâmicas, estado dos *circuit breakers*, *fallback* e adiamentos. Todo teste de carga marca a janela no painel.

### Resposta a incidentes

O pipeline de ação tem três mecanismos já operáveis, documentados em outros pontos: (a) *rollback* de regras por `publish-rules.sh --rollback` ou automático por alarme (ADR-03); (b) *kill switch* de canal por variável do serviço (ADR-05); (c) reprocesso a partir das DLQs. Severidades, papéis e *postmortem* **não foram formalizados**.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| OpenTelemetry + coletor (ADOT) com X-Ray/Prometheus gerenciado | Mais componentes por task e mais custo fixo; o ganho (traces por span) não compensa para um pipeline linear já rastreável por `traceId` nos logs |
| EMF (*Embedded Metric Format*) | Não foi possível confirmar a extração pelo driver `awslogs` no ambiente; filtros de métrica têm comportamento previsível |
| Alarmes por *burn rate* de SLO (rápido e lento) | Mais corretos, mas exigem uma métrica de "bons ÷ total" por janela que ainda não existe; ficam como evolução |
| Prometheus + Grafana próprios | Operação extra sem necessidade; o CloudWatch já está no ambiente |

## Consequências

- Observabilidade completa para o fluxo principal sem componentes extras.
- Os mesmos nomes de métrica servem ao teste local, ao k6 e à AWS.
- A resolução é de ~1 minuto: um pico de latência de segundos não aparece no p99 do CloudWatch (aparece nos logs).
- O alarme de latência usa janelas de 5 min com mínimo de 20 amostras: evita ruído em tráfego baixo, mas um pico de 1 a 2 min não dispara, e o aviso chega com até ~10 min de atraso. Em tráfego muito baixo (0,1% de alertas) ele pode ficar em `INSUFFICIENT_DATA`/OK por não ter amostras; isso é esperado.

## Lacunas conhecidas

| # | Lacuna | Requisito | Saída proposta |
|---|---|---|---|
| 1 | Sem alarmes por *burn rate* | RNF-44 | Métrica de bons/total e duas janelas (1 h e 6 h) |
| 2 | Sem alarme de *circuit breaker* aberto por tempo prolongado | RNF-41 | Métrica `Breaker*` existe; falta o alarme |
| 3 | Sem *runbooks* nem processo de incidente (SEV, papéis, *postmortem*) | RF-52, RNF-47 | Um documento curto com os quatro incidentes prováveis: backlog crescente, DLQ crescendo, canal fora, regra ruim publicada |
| 4 | Sem tracing distribuído por span (só propagação de `traceId`) | RNF-43 | Adotar OpenTelemetry se houver mais serviços no caminho |
| 5 | Nomes de métrica do RNF-03 (`alert_e2e_latency_seconds`) divergem dos implementados (`alert_latency_ms`) | RNF-03 | Alinhar o requisito ao código |
| 6 | Disponibilidade de 99,95% não é medida como SLO | RNF-10 | Depende da métrica do item 1 |

### Fechadas em 13/10/2026

| Lacuna | Como foi fechada |
|---|---|
| Alarme do SLO de latência (RNF-40) | `alert-latency-p99-high`, criado por Terraform (`monitoring.tf`), limiar em `alert_latency_slo_ms` |
| Alarme do *outbox* parado (RNF-41) | `outbox-oldest-pending-high`, limiar em `outbox_pending_max_age_s` |

**Aplicado em 13/10/2026, junto com o teste de 4.000 TPS:** a inclusão dos dois alarmes no widget "Alarmes" do dashboard. O `loadtest.sh` aplica o plano completo, o que incluiu um ajuste de `apply_method` do parâmetro `rds.force_ssl` (drift do provider, sem mudança de valor). Os alarmes ficaram em `INSUFFICIENT_DATA` até o tráfego do teste.

## Gatilhos de revisão

Mais de um serviço no caminho do alerta (adotar OpenTelemetry), exigência de alerta por *burn rate* ou de resolução abaixo de 1 min, ou migração para Prometheus gerenciado por padrão da plataforma.
