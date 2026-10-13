# ADRs — registros de decisões de arquitetura

> Cada ADR traz contexto, decisão, alternativas, consequências e gatilho de revisão. A lista de decisões abertas vem de [01-premissas.md](../01-premissas.md#6-decisões-em-aberto-viram-adrs).

| # | Decisão | Status |
|---|---------|--------|
| [ADR-01](ADR-01-mensageria.md) | SQS padrão na entrada; SNS FIFO e SQS FIFO (alta vazão por grupo) na saída; LocalStack local | aceito |
| [ADR-02](ADR-02-dedupe-e-estado-de-janela.md) | Unicidade do alerta no Postgres (implementada); estado de janela no Redis (`ZSET`, fase 2) decidido e **não implementado** | aceito (unicidade) / adiado (janela) |
| [ADR-03](ADR-03-motor-de-regras.md) | Regras como dados no AWS AppConfig (versões, rollback, *fail-fast* na partida, última versão válida em runtime); subconjunto *stateless* de CEL com interpretador próprio | aceito |
| [ADR-04](ADR-04-armazenamento.md) | PostgreSQL com *outbox*, publicação inline e relay; `audit_log` e `routing_policy` criadas e não utilizadas; DynamoDB descartado | aceito (particionamento só desenhado) |
| [ADR-05](ADR-05-estrategia-de-degradacao.md) | Detecção segue sem dependências auxiliares; Postgres fora: retentativas e DLQ; circuit breaker, *fallback* push → SMS e *kill switch* por canal | aceito |
| [ADR-06](ADR-06-outbox-cdc-debezium.md) | Outbox com CDC (Debezium + Kafka) **não** substitui a publicação inline com relay | aceito |
| [ADR-07](ADR-07-seguranca-autenticacao-e-lgpd.md) | Identidade por IAM/SigV4 (sem mTLS/OAuth2: não há API HTTP), TLS e KMS, rede privada, minimização e LGPD; lacunas listadas | aceito (com lacunas) |
| [ADR-08](ADR-08-observabilidade-e-slos.md) | Logs JSON e métricas por linha de log (CloudWatch), SLOs, alarmes e rollback automático; alarmes de latência e de *outbox* ativos; sem *burn rate* nem *runbooks* ainda | aceito (com lacunas) |

Fora do escopo por decisão do autor: arquivo de eventos brutos em S3 (P-20 fica como desenho).
