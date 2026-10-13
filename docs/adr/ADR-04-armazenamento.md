# ADR-04 — Armazenamento de alertas e entregas

> Status: **aceito**; particionamento e arquivamento **desenhados, não implementados** · Data: 07/10/2026 (revisado em 12/10/2026 para refletir as migrações 001 a 003) · Premissas: P-04, P-20, P-21 · Requisitos: RF-21, RF-22, RF-30 a RF-32, RF-36, RF-43, RNF-12, RNF-15, RNF-27, RNF-28

> **Modelo de dados:** diagrama entidade-relacionamento em [modelo-de-dados.md](../modelo-de-dados.md). As regras de detecção não ficam no banco: vêm do AWS AppConfig em produção e de um arquivo local em desenvolvimento ([ADR-03](ADR-03-motor-de-regras.md)).

## Contexto

Só os alertas (8 a 40 por segundo, até ~125 em pico, P-16) e seus dados de entrega chegam ao banco. Cerca de 99,5% dos eventos não geram alerta e nunca o tocam. O banco precisa garantir unicidade do alerta e atomicidade entre o registro e a publicação.

## Decisão

**PostgreSQL** (compose local; RDS em produção, Multi-AZ no perfil `full` e instância única no perfil `lean`, que foi o testado).

| Tabela | Situação | Conteúdo e observações |
|--------|----------|------------------------|
| `alerts` | **Em uso** | `alert_id` (PK), `dedupe_key` **UNIQUE**, `transaction_id`, `customer_id`, `account_id`, `severity`, `score`, `rules` (jsonb), `summary` (jsonb, sem PII), `degraded`, `late`, `status`, `ingested_at`, `detected_at`, `published_at` |
| `outbox` | **Em uso** | `alert_id` (PK, FK), `payload`, `created_at`, `published_at` (nulo = pendente), `attempts`, `last_error`, `next_attempt_at` (*lease* e *backoff* do relay), `traceparent`; índice parcial `WHERE published_at IS NULL` por `next_attempt_at` |
| `deliveries` | **Em uso** | `delivery_id` (PK), `alert_id`, `channel`, `status`, `attempts`, `last_error`, `updated_at` |
| `audit_log` | **Criada, não utilizada** | Prevista como trilha somente de inserção (`at`, `actor`, `action`, `entity`, `entity_id`, `before`, `after`). Nenhum código a escreve: a auditoria das mudanças de regras é do CloudTrail do AppConfig (ADR-03) |
| `routing_policy` | **Criada, não utilizada** | Prevista para a política e o estado dos canais. O *kill switch* real é por variável de ambiente do serviço ECS (ADR-05) |
| `rule_versions`, `rules_revision` | **Removidas** (migração 003) | Eram a fonte de regras no Postgres, substituída pelo AppConfig (ADR-03) |

`audit_log` e `routing_policy` permanecem no esquema por decisão de escopo; remover as duas é uma migração simples, caso a fase 2 não as reaproveite. Os campos `degraded` e `late` existem no contrato e no banco, mas hoje são sempre `false`: dependem das regras de janela (ADR-02).

**Caminho do alerta:**
1. Uma transação grava o alerta (`ON CONFLICT (dedupe_key) DO NOTHING`) e a linha de *outbox*. Em caso de conflito, é duplicata e nada é gravado.
2. Depois do *commit*, publica **inline** no SNS, com timeout curto (`SNS_PUBLISH_TIMEOUT_MS`, 2 s).
3. Marca `published_at` no *outbox* e no alerta.
4. Confirma (exclui) a mensagem de entrada **depois do passo 1**. Uma falha de publicação no passo 2 **não** devolve a mensagem à fila: o alerta já é durável e a linha de *outbox* segue pendente.
5. Um **relay** periódico (a cada 1 s, lote de 100, `FOR UPDATE SKIP LOCKED` com *lease* em `next_attempt_at`) republica o que ficou pendente há mais de 2 s, com *backoff* exponencial limitado a 60 s. É a rede de segurança para falhas entre os passos 2 e 3. Uma reentrega do evento também completa a publicação pendente (`findPendingByDedupeKey`).

## Alternativas consideradas

| Alternativa | Por que não agora |
|-------------|-------------------|
| DynamoDB (`PutItem` condicional `PENDING`, publicação, `UpdateItem`, sweeper por GSI esparso) | Defensável e 100% AWS, mas as consultas e a trilha ficam mais custosas, e o ambiente local é menos simples. O GSI é eventualmente consistente |
| DynamoDB Streams como *outbox* | Põe dois saltos (stream e Lambda) no caminho crítico do alerta |
| CDC com Debezium + Kafka | Avaliada e descartada no [ADR-06](ADR-06-outbox-cdc-debezium.md) |

## Consequências

- Unicidade e *outbox* atômicos por transação.
- Cada instância usa um *pool* de conexões; em produção com mais instâncias, PgBouncer ou RDS Proxy (não implementado). O Postgres é ponto único no caminho do alerta. No perfil `lean` não há Multi-AZ; no `full` há. Sem banco, o evento com alerta volta à fila com recuo (ADR-05).
- **Retenção de 5 anos (P-20):** no limite superior são centenas de milhões a mais de um bilhão de alertas por ano. A evolução é particionar `alerts` por mês e arquivar partições antigas em S3. Atenção: no Postgres, uma restrição `UNIQUE` em tabela particionada precisa incluir a chave de partição, o que quebraria a unicidade entre meses. A solução é uma tabela pequena `alert_dedupe (dedupe_key PK, created_at)`, com expurgo após o prazo de reprocessamento (a DLQ retém 14 dias, P-21), mantendo `alerts` sem `UNIQUE` global. **Desenhado, não implementado**; também não há rotina de expurgo ou anonimização.
- Não há API de consulta de alertas (RF-38 não implementado); o acesso é por SQL e pelas métricas.

## Gatilhos de revisão

Volume de alertas uma ordem de grandeza acima do previsto, exigência de arquitetura 100% *serverless*, ou gargalo de escrita medido em teste de carga. A 4.000 TPS o RDS (`db.t4g.medium`) ficou em 15,9% de CPU e ~32 conexões.
