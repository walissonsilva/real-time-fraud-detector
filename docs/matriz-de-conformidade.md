# Matriz de conformidade

> Status: **vivo** · Verificada em 13/10/2026 contra o código (`main`, commit `92e37fe`) e contra os testes na AWS ([registro](registro-testes-aws.md)). Requisitos: [02](02-requisitos-funcionais.md) e [03](03-requisitos-nao-funcionais.md).

Esta matriz diz, requisito por requisito, **o que foi entregue e qual é a evidência**. Onde o requisito original foi escrito para um desenho que mudou (API de regras, Redis, mTLS), a coluna "Situação" avalia o requisito como está escrito e a observação diz o que o substituiu.

**Legenda:** ✅ atendido · 🟡 parcial · ❌ não atendido · ⏭️ não medido (a implementação existe, falta a medição).

## Resumo

| Grupo | Total | ✅ | 🟡 | ❌ | ⏭️ |
|---|---|---|---|---|---|
| RF (funcionais) | 42 | 21 | 10 | 11 | 0 |
| RNF (não funcionais) | 46 | 16 | 21 | 6 | 3 |

Dos 29 RF de prioridade **M**, 21 estão atendidos e 8 ficaram parciais ou não atendidos: RF-11 (sem regras de MCC e horário), RF-17 (sem log amostrado), RF-18 (porta `WindowStateStore` só desenhada), RF-20 e RF-22 (API de gestão e aprovação substituídas pelo AppConfig), RF-51 (sem spans), RF-52 (sem *runbooks*, o único não atendido) e RF-53 (*kill switch* não é instantâneo). Os não atendidos em S e C estão em [Limitações conhecidas](../README.md#limitações-conhecidas-e-próximos-passos).

## Requisitos funcionais

### RF-1 Ingestão

| ID | Prio | Situação | Evidência e observações |
|---|---|---|---|
| RF-01 | M | ✅ | `SqsTransactionConsumer` consome da fila `transactions`; e2e `process-transaction.e2e-spec.ts` |
| RF-02 | M | ✅ | `AjvTransactionEventValidator` + `RejectInvalidEventService`: DLQ com motivo e original, sem interromper o fluxo; `invalid-events.int-spec.ts`, `reject-invalid.e2e-spec.ts` |
| RF-03 | S | ❌ | Não há `POST /v1/transactions`; a entrada é só pelo barramento (ADR-01). Removido do OpenAPI |
| RF-04 | M | ✅ | `dedupe_key` com `UNIQUE` e `ON CONFLICT DO NOTHING` (ADR-02); e2e "o mesmo evento enviado duas vezes gera exatamente 1 alerta"; 0 duplicados em 1.000 e 4.000 TPS |
| RF-05 | M | ✅ | `ingestedAt` = `SentTimestamp` do SQS; `consumedAt` no início do processamento (`sqs-transaction.consumer.ts`). Se o atributo faltar, usa o relógio local (degradação de medida, não de função) |

### RF-2 Detecção

| ID | Prio | Situação | Evidência e observações |
|---|---|---|---|
| RF-10 | M | ✅ | `ProcessTransactionService` + `DeclarativeRuleEngine` + `decision.ts` |
| RF-11 | M | 🟡 | Quatro regras *stateless* em `config/rules.json`: valor alto, valor alto para contraparte nova, país de risco, canal × tipo incomuns. O campo `mcc` existe no evento, mas **não há regra de MCC nem de horário atípico** entregue; a linguagem as comportaria |
| RF-12 | S | ❌ | Regras com janela não implementadas (fase 2 cortada por prazo; ADR-02) |
| RF-13 | S | 🟡 | Listas entram como `params` da regra (ex.: `countries`, `in params.countries`); não há *deny/allow list* gerenciada nem por contraparte/dispositivo |
| RF-14 | C | ❌ | Não implementado |
| RF-15 | C | ❌ | Não implementado |
| RF-16 | M | ✅ | `decision.ts`: severidade = maior entre as regras; `score` = soma dos pesos limitada a `MAX_SCORE`; `decision.spec.ts` |
| RF-17 | M | 🟡 | Sem alerta: métrica (`events_processed_total`) e nada gravado. **Log de decisão amostrado não existe** |
| RF-18 | M | 🟡 | Regras `WINDOWED` são **rejeitadas na validação** com erro claro (`rules-document.validator.ts:76`; cenário 12). A porta `WindowStateStore` **não existe no código**; só está desenhada no ADR-02 |

### RF-3 Gestão de regras sem redeploy

| ID | Prio | Situação | Evidência e observações |
|---|---|---|---|
| RF-20 | M | 🟡 | Regras são dados (JSON declarativo, `rule.v1`) e mudam sem redeploy, mas **não há API** de CRUD: a gestão é por `publish-rules.sh` e AppConfig (ADR-03) |
| RF-21 | M | ✅ | Cada publicação é uma versão hospedada imutável do AppConfig; o documento inteiro tem `revision` |
| RF-22 | M | 🟡 | Versão e *rollback* de um comando (`publish-rules.sh --rollback`, cenário 3 do registro) e automático por alarme (cenário 4). **Não há `DRAFT → ACTIVE` nem aprovador ≠ autor**; a separação de funções depende de quem pode chamar `StartDeployment` no IAM. CloudTrail registra |
| RF-23 | M | ✅ | Sondagem de 20 s com troca atômica do snapshot; medido: 3 instâncias na revisão nova em 2 a 6 s (T053) e em ≤ 25 s (cenário 1); mantém a última válida (`rules-source-outage.int-spec.ts`) |
| RF-24 | S | 🟡 | O campo `mode: SHADOW` existe e é aceito, mas o motor **apenas ignora** a regra (`declarative-rule-engine.ts:265`): não avalia nem registra. O objetivo (calibrar) não é atendido |
| RF-25 | S | ❌ | Sem dry-run. O que há é `scripts/rules/validate-rules.ts` (validação de sintaxe e contrato), não simulação contra eventos |
| RF-26 | M | ✅ | Validação por JSON Schema (expressão ≤ 2.000 caracteres) e análise sintática pelo interpretador próprio, sem `eval`, sem laços e sem chamadas arbitrárias; vale em `publish-rules.sh`, no validador do AppConfig e na partida; `rules-document.validator.spec.ts` |
| RF-27 | C | ❌ | Não implementado (o AppConfig tem estratégia gradual de deployment, usada no cenário 4) |

### RF-4 Alertas

| ID | Prio | Situação | Evidência e observações |
|---|---|---|---|
| RF-30 | M | ✅ | `FraudAlert v1` (`alerts/types/fraud-alert.ts`), `summary` sem PII; validado em `contracts.spec.ts` |
| RF-31 | M | ✅ | `UNIQUE (dedupe_key)`; `outbox-publish.int-spec.ts` cenário 4 (reentrega sequencial e concorrente: 1 alerta, 1 mensagem por canal) |
| RF-32 | M | ✅ | Alerta e *outbox* na mesma transação; publicação inline e relay; `outbox-publish.int-spec.ts`, `relay-outbox.int-spec.ts` (ADR-04) |
| RF-33 | S | ❌ | Todo alerta vai aos dois canais por *fan-out* SNS; não há política por severidade ou regra |
| RF-34 | M | ✅ | Fila SQS FIFO do antifraude (`antifraud-queue.provider.ts`). É fila, não webhook |
| RF-35 | M | ✅ | Push e SMS por provedores **simulados** (`customer-push.provider.ts`, `customer-sms.provider.ts`), permitido pelo requisito |
| RF-36 | M | ✅ | Retry exponencial com *jitter* (`shared/retry.ts`), *circuit breaker* por provedor, DLQ por canal, *fallback* push → SMS; `deliver-alert.service.spec.ts`, `channel-delivery.e2e-spec.ts` (ADR-05) |
| RF-37 | S | ❌ | Sem controle de fadiga |
| RF-38 | S | ❌ | Sem API de consulta nem de atualização de status; o acesso é por SQL |
| RF-39 | M | ✅ | `alertId` e `deliveryId` determinístico em toda mensagem de canal (`delivery-id.ts`); reentrega não repete a entrega (`channel-delivery.int-spec.ts`) |

### RF-5 Degradação e recuperação

| ID | Prio | Situação | Evidência e observações |
|---|---|---|---|
| RF-40 | M | ✅ | `rules-source-outage.int-spec.ts`; alarmes `rules-refresh-*` |
| RF-41 | S | ❌ | Depende do estado de janelas (não implementado). Redis provisionado, mas ocioso |
| RF-42 | M | ✅ | Falha de provedor: retry, breaker, adiamento ou DLQ de canal, detecção intocada; `channel-delivery.int-spec.ts` cenário 5 |
| RF-43 | M | ✅ | Banco fora: a mensagem não é confirmada e volta com recuo (2/4/8 s); esgotadas 3 retentativas vai à DLQ `MAX_RETRIES_EXCEEDED`, sem perda (ADR-05). **Decisão aberta:** banco fora por mais de ~14 s manda eventos à DLQ |
| RF-44 | S | 🟡 | A idempotência garante que reprocessar não duplica, mas **não há ferramenta de reprocesso**; o *redrive* das DLQs é manual (console/CLI da AWS) |
| RF-45 | M | ✅ | `enableShutdownHooks` em `main.ts`; `SqsTransactionConsumer` e o *pool* implementam `OnApplicationShutdown` |

### RF-6 Operação

| ID | Prio | Situação | Evidência e observações |
|---|---|---|---|
| RF-50 | M | ✅ | `/health/live` e `/health/ready` (falha só se o Postgres cair; o Redis é informativo); `health.e2e-spec.ts` |
| RF-51 | M | 🟡 | Métricas, logs JSON e `traceId` propagado (`trace-propagation.int-spec.ts`); **sem spans** de tracing (ADR-08) |
| RF-52 | M | ❌ | Sem *runbooks* (ADR-08, lacuna 3). Existem procedimentos operacionais dispersos (`publish-rules.sh --rollback`, README do Terraform) |
| RF-53 | M | 🟡 | Canal: variável `CHANNEL_*_DISABLED` do serviço ECS (ADR-05), que exige novo *deployment* das tasks, ainda que sem build. Regra: publicar nova revisão (cenários 1 e 3), sem reinício de task. Não há chave instantânea |

### Cenários críticos

| # | Cenário | Situação | Evidência |
|---|---|---|---|
| 1 | Evento duplicado | ✅ | `process-transaction.e2e-spec.ts` |
| 2 | Corrida entre consumidores | ✅ | `outbox-publish.int-spec.ts` cenário 4 (concorrente) |
| 3 | Falha entre persistir e publicar | ✅ | `outbox-publish.int-spec.ts` cenário 3; `relay-outbox.int-spec.ts` |
| 4 | Fora de ordem (fase 2) | ❌ | Fase 2 não entregue |
| 5 | Regra nova vale em ≤ 30 s; rollback | ✅ | Registro: cenários 1, 3 e T053 na AWS |
| 6 | Repositório de regras fora | ✅ | `rules-source-outage.int-spec.ts` (AWS: ⏭️, ver registro #7) |
| 7 | Estado de janelas fora (fase 2) | ❌ | Fase 2 não entregue |
| 8 | Provedor fora | ✅ | `channel-delivery.e2e-spec.ts`, `channel-delivery.int-spec.ts` |
| 9 | Rajada de 25k TPS | ⏭️ | **Não executada** (cotas de Fargate e do gerador; registro A11) |
| 10 | Evento malformado | ✅ | `invalid-events.int-spec.ts` |
| 11 | Regra maliciosa ou lenta | ✅ | `rules-document.validator.spec.ts`; AWS: cenários 5a e 5b |
| 12 | Regra `WINDOWED` na fase 1 | ✅ | `rules-document.validator.spec.ts` |

## Requisitos não funcionais

### RNF-1 Desempenho e escalabilidade

| ID | Situação | Evidência e observações |
|---|---|---|
| RNF-01 | ⏭️ | Meta: 8.000 TPS por 1 h. **Medido: 4.000 TPS por 5 min de janela estável** (aprovado), 6 tasks, CPU 49,6% (ECS) e 15,9% (RDS). 8k não foi executado; a estimativa linear é de 10 a 12 tasks (**estimativa, não medição**) |
| RNF-02 | ⏭️ | 25k TPS não executado. Há *buffer* de SQS e alarme de idade da fila, sem prova de drenagem em ≤ 5 min |
| RNF-03 | 🟡 | **A 4.000 TPS:** serviço p50 35 · p95 90 · **p99 174 ms** (máx. 475 ms); e2e p99 207 ms (inclui envio e *fan-out*). Atende as metas, mas a 4k e não a 8k. Nomes de métrica divergem do requisito (`alert_latency_ms`, não `alert_e2e_latency_seconds`; sem `queue_wait_seconds`; ADR-08, lacuna 5) |
| RNF-04 | ❌ | Orçamento por etapa não é medido: sem spans por etapa. Só se mede o total (e2e) |
| RNF-05 | 🟡 | 1.000 TPS com 3 tasks (CPU 22 a 31%) e 4.000 TPS com 6 tasks (50%), compatível com crescimento ~linear; não foi feito o teste N × 2N controlado |
| RNF-06 | ✅ | Caminho quente sem componente central **exceto o Postgres** (instância única no perfil `lean`; Multi-AZ no `full`). Só 1% dos eventos o toca; CPU 15,9% a 4k (ADR-04) |
| RNF-07 | 🟡 | Regras compiladas (AST em cache por regra, `parsed()`), mas **sem *benchmark*** de 1 ms/regra. Indiretamente: avaliação cabe no p99 de 174 ms ponta a ponta |
| RNF-08 | ✅ | O consumo é por *polling* limitado; sem consumo, a fila acumula (SQS) e há alarme de idade. Não há teste de sobrecarga controlado |

### RNF-2 Disponibilidade, resiliência e consistência

| ID | Situação | Evidência e observações |
|---|---|---|
| RNF-10 | ⏭️ | 99,95% **não medido como SLO** (ADR-08, lacuna 6); só os componentes |
| RNF-11 | ✅ | Falha de regras, provedor e canal não interrompe a detecção (RF-40, RF-42); estado de janelas não se aplica. Sem teste de caos formal |
| RNF-12 | ✅ | *Ack* só depois de gravar alerta e *outbox*; `no-silent-loss.int-spec.ts`. Sem teste de morte de processo |
| RNF-13 | 🟡 | ECS substitui tasks e a DLQ retém 14 dias, mas **RTO de 5 min nunca foi exercitado** |
| RNF-14 | ✅ | At-least-once + `UNIQUE` + *outbox*; 0 duplicados em 1k e 4k TPS (1,7 milhão de eventos somados) |
| RNF-15 | ✅ | Unicidade por restrição no banco (não só cache); TTL não se aplica (sem tabela de dedupe separada, ADR-04) |
| RNF-16 | ❌ | Fase 2 não entregue |
| RNF-17 | 🟡 | Filas, *consumers* e DLQ por canal e *breaker* por provedor; *pool* de conexões e processo são compartilhados |
| RNF-18 | ✅ | `withTimeout` e `retry` com *jitter* em publicação, envio e DLQ; SNS 2 s, canal 2 s; retry só em operações idempotentes |
| RNF-19 | 🟡 | ECS e subnets em ≥ 2 AZs; RDS Multi-AZ **só no perfil `full`** (o testado, `lean`, é instância única); Redis sem réplica no `lean` |

### RNF-3 Segurança e conformidade

| ID | Situação | Evidência e observações |
|---|---|---|
| RNF-20 | ✅ | `rds.force_ssl`, `sslmode=verify-full`, Redis com `transit_encryption_enabled`, SQS/SNS por HTTPS (ADR-07) |
| RNF-21 | 🟡 | SSE em filas, RDS, S3 e logs; **CMK própria só no perfil `full`** (`enable_cmk`); no `lean` usa chaves gerenciadas (ADR-07) |
| RNF-22 | 🟡 | **Substituído:** IAM/SigV4 entre serviços, sem mTLS nem OAuth2, porque não há API HTTP de negócio (ADR-07). `/metrics` e `/health` não têm autenticação, mas ficam em rede privada |
| RNF-23 | 🟡 | Mínimo privilégio por *role* de task, e IAM para quem publica regras. Os papéis nomeados (`fraud-rules-admin` etc.) **não existem** |
| RNF-24 | ✅ | Contratos só com tokens; `summary` sem PII; revisão dos schemas em `docs/contratos` |
| RNF-25 | 🟡 | Redação por lista de chaves (`observability/logger.ts`, `logger.spec.ts`) e checagem de PII nos testes de eventos inválidos. É por **chave**, não por conteúdo: um valor sensível em campo não listado passaria |
| RNF-26 | 🟡 | Retenção das filas e DLQ de 14 dias; **sem expurgo/TTL em `alerts`** (5 anos, P-20, é desenho) |
| RNF-27 | ❌ | `customer_id` é gravado, mas **não há índice** nem rotina de acesso/eliminação (ADR-07, lacuna) |
| RNF-28 | 🟡 | Mudança de regras auditada pelo CloudTrail do AppConfig (verificado). `audit_log` **existe e não é usada**; mudanças de status de alerta não existem |
| RNF-29 | 🟡 | Imagem `node:22-alpine`, usuário `node`, segredos no Secrets Manager e `.env` fora do git. **Sem varredura de vulnerabilidades** no CI (sem `npm audit` nem Dependabot) |
| RNF-30 | 🟡 | Sem `eval` e com expressão limitada (RF-26). Não há API HTTP de negócio, então limite de taxa e tamanho de *payload* não se aplicam; a validação de entrada é por schema |

### RNF-4 Observabilidade e operação

| ID | Situação | Evidência e observações |
|---|---|---|
| RNF-40 | 🟡 | SLOs definidos no ADR-08. Latência e *freshness* têm alarme; **disponibilidade e taxa de entrega ≥ 99,9% em 1 min** não são medidas como SLI |
| RNF-41 | 🟡 | Métricas de fila, DLQ, *outbox*, entregas, regras e estado de *breaker*, e CPU de ECS/RDS/Redis. Faltam *event loop lag*, memória, *hit ratio* e tempo de espera na fila (`queue_wait_seconds`); a idade do *breaker* aberto não alarma |
| RNF-42 | 🟡 | JSON com `traceId`, `transactionId`, `alertId`. Sem `ruleId` em todo log e **sem amostragem** de decisões sem alerta |
| RNF-43 | 🟡 | `traceparent` propagado de ponta a ponta e testado; **sem spans** nem exportação para ferramenta de tracing |
| RNF-44 | ❌ | Alarmes por limite estático; **sem *burn rate*** nem `runbook` associado (ADR-08, lacuna 1) |
| RNF-45 | ✅ | Dashboard `fraud-detector-operacao` (saúde, canais, regras, dependências) |
| RNF-46 | 🟡 | Ver RF-53 |
| RNF-47 | ❌ | Sem SEV, papéis nem modelo de *postmortem* (ADR-08, lacuna 3) |

### RNF-5 Manutenibilidade e qualidade

| ID | Situação | Evidência e observações |
|---|---|---|
| RNF-50 | ✅ | Domínio e adaptadores separados em módulos Nest (`alerts`, `rules`, `deliveries`, `transactions`) com portas (`RuleSource`, `NotificationProvider`, *event bus*); sem a porta `WindowStateStore` |
| RNF-51 | ✅ | Contratos `v1` validados em CI (`contracts:validate`) e no `contracts.spec.ts` |
| RNF-52 | 🟡 | 208 testes unitários (207 passam em execução com cobertura; o que falhou foi *timeout* de 5 s sob carga da cobertura, e passa isolado, 31 de 31) e 11 arquivos de integração e e2e. **A cobertura de 80% não é medida nem imposta no CI**; cenários de fase 1 estão cobertos (ver acima) |
| RNF-53 | 🟡 | Unitários, integração (LocalStack e Postgres), contratos e carga (k6). **Não há testes de caos** |
| RNF-54 | ✅ | Terraform completo (perfis `lean` e `full`), CI no GitHub Actions (lint, build, unitário, contrato, integração, e2e, build da imagem) e *rolling update* validado em 10/10. **Não há CD**: o deploy é por script manual |
| RNF-55 | ✅ | Configuração por variáveis de ambiente (`config.module.ts`); segredos no Secrets Manager |
| RNF-56 | ✅ | ADR-01 a ADR-08 com alternativas, consequências e gatilhos |

### RNF-6 Custo

| ID | Situação | Evidência e observações |
|---|---|---|
| RNF-60 | ✅ | Execução local por Docker Compose e LocalStack; AWS por Terraform com `up`, `pause`, `resume` e `destroy` e orçamento com alarme |
| RNF-61 | ❌ | **Sem estimativa de custo mensal** em produção no repositório (só custo operacional do teste e orçamento) |

## Lacunas de maior impacto, em ordem

Critério: o que a avaliação do desafio provavelmente cobra e o que é barato de fechar.

| # | Lacuna | Requisitos | Esforço |
|---|---|---|---|
| 1 | Estimativa de custo mensal na apresentação | RNF-61 | Baixo (documento) |
| 2 | *Runbooks* e processo de incidente (4 incidentes + SEV + *postmortem*) | RF-52, RNF-47 | Baixo (documento) |
| 3 | Modo SHADOW que **avalia e registra** | RF-24 | Baixo a médio (código e teste) |
| 4 | Varredura de vulnerabilidades no CI (`npm audit`, Dependabot) e meta de cobertura | RNF-29, RNF-52 | Baixo |
| 5 | Alarme de *breaker* aberto e *burn rate* | RNF-41, RNF-44 | Médio (Terraform) |
| 6 | Índice por `customer_id` e rotina de expurgo/anonimização | RNF-26, RNF-27 | Médio (migração) |
| 7 | Regra de MCC e de horário atípico (os campos existem) | RF-11 | Baixo (dados) |
| 8 | Teste de 8k e de rajada de 25k | RNF-01, RNF-02 | Alto (cota Fargate 16 vCPU + shards de k6) |
| 9 | Estado de janelas (regra de velocidade) | RF-12, RF-18, RF-41, RNF-16 | Alto |
