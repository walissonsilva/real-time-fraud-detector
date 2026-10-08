# ADRs — registros de decisões de arquitetura

> Cada ADR traz contexto, decisão, alternativas, consequências e gatilho de revisão. A lista de decisões abertas vem de [01-premissas.md](../01-premissas.md#6-decisões-em-aberto-viram-adrs).

| # | Decisão | Status |
|---|---------|--------|
| [ADR-01](ADR-01-mensageria.md) | SQS padrão na entrada; SNS FIFO e SQS FIFO na saída; LocalStack local | proposto |
| [ADR-02](ADR-02-dedupe-e-estado-de-janela.md) | Unicidade do alerta no Postgres; estado de janela no Redis (`ZSET`, fase 2) | proposto |
| [ADR-03](ADR-03-motor-de-regras.md) | Regras como dados no Postgres, recarga por *polling*; CEL ou JSON Logic **em aberto** | proposto, linguagem em aberto |
| [ADR-04](ADR-04-armazenamento.md) | PostgreSQL com *outbox*, publicação inline e relay; DynamoDB descartado por ora | proposto |
| [ADR-05](ADR-05-estrategia-de-degradacao.md) | *Fail-open* com marcação `degraded`; Postgres fora gera *backpressure* | proposto |

Fora do escopo por decisão do autor: arquivo de eventos brutos em S3 (P-20 fica como desenho).
