# 03 — Requisitos não funcionais

> Status: **rascunho v0.1** · Premissas: [01-premissas.md](01-premissas.md)
> Cada RNF é **mensurável** e tem a forma de verificá-lo. Os números vêm das premissas P-10 a P-20.

## RNF-1 Desempenho e escalabilidade

| ID | Requisito | Meta | Como verificar |
|----|-----------|------|----------------|
| RNF-01 | Vazão sustentada | 8.000 TPS, 1 h contínua, sem acúmulo de *lag* | Teste de carga k6 (*constant-arrival-rate*) |
| RNF-02 | Vazão em pico | 25.000 TPS por 15 min; o *lag* pode crescer, mas drena em ≤ 5 min após o pico | k6 com rampa e pico |
| RNF-03 | Latência ponta a ponta, **incluindo a fila** (`ingestedAt` = aceite no barramento → `alert.publishedAt`) | p50 ≤ 150 ms · p95 ≤ 300 ms · **p99 ≤ 500 ms** em 8k TPS | Métrica `alert_e2e_latency_seconds` (histograma, alertas); `decision_latency_seconds` para **todos** os eventos (base do SLI do RNF-10); `queue_wait_seconds` (`consumedAt − ingestedAt`) para isolar a fila |
| RNF-04 | Orçamento de latência (p99) | Fila (aceite no barramento → consumo) 100 ms · ingestão/validação 30 ms · avaliação de regras 150 ms · estado de janela 50 ms (fase 2; sem ele a folga sobe para 120 ms) · persistência + *outbox* 100 ms · folga 70 ms | Spans de tracing por etapa |
| RNF-05 | Escalabilidade horizontal | Vazão cresce de forma ~linear com o número de *workers*; sem estado local não recuperável | Teste com N, 2N *workers* |
| RNF-06 | Sem gargalo único | Nenhum componente centralizado em série no caminho quente (ex.: instância única de banco de regras) | Revisão de arquitetura |
| RNF-07 | Avaliação de regras | ≤ 1 ms de CPU por regra em média; regras compiladas e mantidas em memória | *Benchmark* |
| RNF-08 | Backpressure | Sob sobrecarga, o sistema desacelera o consumo (não perde eventos nem estoura memória) | Teste de caos/sobrecarga |

## RNF-2 Disponibilidade, resiliência e consistência

| ID | Requisito | Meta | Como verificar |
|----|-----------|------|----------------|
| RNF-10 | Disponibilidade do pipeline de detecção | 99,95% mensal (≈ 22 min de indisponibilidade/mês) | SLI de sucesso = eventos processados no SLO / eventos recebidos |
| RNF-11 | Tolerância a falha de dependência auxiliar | Falha de regras, estado de janelas, provedor ou canal **não interrompe** a detecção (ver RF-40 a RF-43) | Testes de caos por dependência |
| RNF-12 | Perda de dados | **RPO = 0** para eventos aceitos (só se confirma o *ack* depois de persistir o resultado) | Teste de morte de processo durante o processamento |
| RNF-13 | Recuperação | RTO ≤ 5 min (reinício de *workers*/failover); reprocessamento de DLQ sob demanda | Exercício de recuperação |
| RNF-14 | Semântica de entrega | Entrada *at-least-once* + consumidor idempotente + *outbox* ⇒ **alerta efetivamente único** por `transactionId`. Entrega a canais externos é *at-least-once*; duplicidade residual é mitigada por `alertId` como chave de idempotência no receptor | Testes de duplicidade e *race* |
| RNF-15 | Idempotência | Dedupe por `transactionId` com TTL ≥ janela máxima de reentrega do broker + 24 h; a unicidade do alerta é garantida por **restrição de unicidade no armazenamento** (não só por cache) | Teste de concorrência |
| RNF-16 | Ordenação (fase 2) | Ordem por `accountId` (P-18); sem exigência global | Teste com eventos embaralhados |
| RNF-17 | Isolamento de falhas | *Bulkhead*: canais, provedores e DLQ têm filas e *pools* próprios; um provedor lento não afeta os demais | Teste de latência injetada |
| RNF-18 | Timeouts e *retries* | Todo I/O tem *timeout* explícito; *retry* só em operações idempotentes, com limite e *jitter* | Revisão de código + testes |
| RNF-19 | Multi-AZ | Implantação em ≥ 2 AZs; sem dependência de uma única AZ | Revisão da arquitetura |

## RNF-3 Segurança e conformidade (LGPD)

| ID | Requisito | Meta | Como verificar |
|----|-----------|------|----------------|
| RNF-20 | Cripto em trânsito | TLS 1.2+ (preferir 1.3) em todo o tráfego, inclusive com o barramento e o banco | Varredura de configuração |
| RNF-21 | Cripto em repouso | Filas, bancos, backups e logs cifrados com KMS; rotação anual de chaves | Revisão de IaC |
| RNF-22 | Autenticação entre serviços | mTLS (identidade de workload) e/ou OAuth2 *client credentials* com JWT de curta duração para APIs | Teste de acesso negado sem credencial |
| RNF-23 | Autorização | Mínimo privilégio; papéis: `fraud-rules-admin`, `fraud-rules-approver`, `fraud-analyst`, `producer`; IAM por serviço | Testes de autorização |
| RNF-24 | Minimização de dados | Contratos sem PAN/CPF/nome; só tokens e o mínimo para detecção | Revisão dos schemas |
| RNF-25 | PII em logs | **Zero** PII em logs/métricas/traces; identificadores sempre tokenizados/mascarados | Teste automatizado de *log scrubbing* |
| RNF-26 | Retenção e descarte | Conforme P-20, com expiração automática (TTL) | Revisão de IaC |
| RNF-27 | Direitos do titular | Alertas e eventos localizáveis por `customerId` (token) para atender acesso/eliminação, respeitando a retenção legal antifraude | Documentado + consulta por índice |
| RNF-28 | Auditoria | Toda mudança de regra, publicação, *rollback*, mudança de status de alerta e acesso administrativo é registrada de forma imutável (quem, quando, o quê, antes/depois) | Teste de trilha |
| RNF-29 | Supply chain | Dependências com varredura de vulnerabilidades; imagem mínima, não *root*; *secrets* fora do repositório | CI |
| RNF-30 | Resistência a abuso | Limite de taxa e tamanho máximo de *payload* na API; validação rigorosa de entrada; sem *eval* de código arbitrário nas regras | Testes de segurança |

## RNF-4 Observabilidade e operação (SRE)

| ID | Requisito | Meta |
|----|-----------|------|
| RNF-40 | **SLIs/SLOs** definidos: latência p99 (RNF-03), disponibilidade (RNF-10), *freshness* de regras (≤ 30 s), taxa de entrega de alertas (≥ 99,9% em 1 min no canal interno) |
| RNF-41 | Métricas (RED + USE + negócio): taxa de eventos, erros, latência por etapa, *lag* do consumidor, idade da mensagem mais antiga, tempo de espera na fila (`queue_wait_seconds`), tamanho da DLQ, taxa de alertas por regra, taxa de avaliação por regra, *hit ratio* de cache, estado de *circuit breakers*, saturação de CPU/memória/*event loop lag* |
| RNF-42 | *Logs* estruturados (JSON) com `traceId`, `transactionId` (token), `ruleId`; amostragem para decisões "sem alerta" |
| RNF-43 | *Tracing* distribuído (W3C `traceparent`) propagado desde o evento de entrada até a entrega do alerta |
| RNF-44 | Alertas operacionais baseados em **burn rate** de SLO (rápido e lento), não só em limites estáticos; cada alerta aponta para um *runbook* |
| RNF-45 | *Dashboards*: saúde do pipeline, regras, canais, dependências |
| RNF-46 | *Feature flags*/*kill switches* para regras e canais (RF-53) |
| RNF-47 | Resposta a incidentes: severidades SEV1–SEV3, papéis, *runbooks* e modelo de *postmortem* sem culpados |

## RNF-5 Manutenibilidade e qualidade

| ID | Requisito | Meta |
|----|-----------|------|
| RNF-50 | Arquitetura em camadas/hexagonal: domínio (regras, alerta) sem dependência de framework, broker ou banco; portas e adaptadores | Revisão |
| RNF-51 | Contratos versionados (`v1`), com regras de evolução compatível (ver [contratos/README](contratos/README.md)) | Testes de contrato |
| RNF-52 | Cobertura: ≥ 80% no domínio; 100% dos cenários críticos da fase 1 (lista no fim do doc 02) cobertos por teste automatizado; os da fase 2 só se ela for entregue | CI |
| RNF-53 | Pirâmide de testes: unitários (domínio) → integração (broker/banco em contêiner) → contrato → carga → caos | CI + k6 |
| RNF-54 | Infra como código e *pipeline* de CI/CD reproduzível; implantação sem *downtime* (*rolling*) | IaC |
| RNF-55 | Configuração externa (12-factor), sem segredos no código | Revisão |
| RNF-56 | Cada decisão relevante tem um ADR com alternativas e trade-offs | Pasta `docs/adr` |

## RNF-6 Custo

| ID | Requisito | Meta |
|----|-----------|------|
| RNF-60 | A solução de validação deve ser executável localmente e, se for à AWS, com custo de teste pequeno e destruível (IaC) | Documentado |
| RNF-61 | Estimativa de custo mensal da solução em produção (ordem de grandeza) incluída na apresentação | Documento |

## Trade-offs conscientes

| Tensão | Escolha inicial | Motivo |
|--------|-----------------|--------|
| Latência × consistência forte | Consistência forte **só** onde importa (unicidade do alerta); estado de janela (fase 2) com consistência eventual | O alerta duplicado é inaceitável; um contador de janela ligeiramente defasado não |
| Simplicidade × robustez | Pipeline linear com *outbox* e idempotência no armazenamento; sem *exactly-once* distribuído | *Exactly-once* fim a fim é caro e frágil; *at-least-once* + idempotência dá o mesmo efeito |
| Disponibilidade × precisão (degradação) | *Fail-open* com marcação `degraded` para regras com janela | Perder detecção silenciosamente é pior do que alertar com precisão menor (P-01) |
| Flexibilidade × desempenho de regras | Regras declarativas compiladas e cacheadas | Evita *parse* por evento |
