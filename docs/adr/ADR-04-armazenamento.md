# ADR-04 — Armazenamento de alertas, regras e auditoria

> Status: **proposto** · Data: 07/10/2026 · Premissas: P-04, P-20, P-21 · Requisitos: RF-21, RF-22, RF-30 a RF-32, RF-36, RF-43, RNF-12, RNF-15, RNF-27, RNF-28

## Contexto

Só os alertas (8 a 40 por segundo, até ~125 em pico, P-16) e os dados de gestão chegam ao banco. Cerca de 99,5% dos eventos não geram alerta e nunca o tocam. O banco precisa garantir unicidade do alerta, atomicidade entre o registro e a publicação, regras versionadas e uma trilha de auditoria.

## Decisão

**PostgreSQL** (compose local; RDS Multi-AZ em produção).

| Tabela | Conteúdo e observações |
|--------|------------------------|
| `alerts` | `alert_id` (PK), `dedupe_key` **UNIQUE**, `transaction_id`, `customer_id`, `account_id`, `severity`, `score`, `rules` (jsonb), `summary` (jsonb, mascarado), `degraded`, `late`, `status`, `ingested_at`, `detected_at`, `published_at` |
| `outbox` | `alert_id`, `payload`, `created_at`, `published_at` (nulo = pendente); índice parcial `WHERE published_at IS NULL` |
| `deliveries` | `delivery_id` (PK), `alert_id`, `channel`, `status`, `attempts`, `last_error`, `updated_at` |
| `rule_versions` | `(rule_id, version)` (PK), `status`, `definition` (jsonb), `author`, `approver`, `created_at`, `activated_at` |
| `rules_revision` | Contador de revisão (uma linha) incrementado ao ativar, desativar ou reverter, usado no *polling* |
| `audit_log` | Somente inserção (`REVOKE UPDATE, DELETE`): `at`, `actor`, `action`, `entity`, `entity_id`, `before`, `after`. Gravada **na mesma transação** da mudança |
| `routing_policy` | Política de canais e estado de cada canal (*kill switch*) |

**Caminho do alerta:**
1. Uma transação grava o alerta (`ON CONFLICT (dedupe_key) DO NOTHING`) e a linha de *outbox*. Em caso de conflito, é duplicata e nada é gravado.
2. Depois do *commit*, publica **inline** no SNS, com *retry* curto dentro do orçamento de latência (RNF-04).
3. Marca `published_at` no *outbox* e no alerta.
4. Só então confirma (*ack*) a mensagem de entrada.
5. Um **relay** periódico (a cada ~5 s, `FOR UPDATE SKIP LOCKED`) republica o que ficou pendente há mais de ~30 s. É a rede de segurança para falhas entre os passos 1 e 3 e para mensagens que foram para a DLQ.

## Alternativas consideradas

| Alternativa | Por que não agora |
|-------------|-------------------|
| DynamoDB (`PutItem` condicional `PENDING`, publicação, `UpdateItem`, sweeper por GSI esparso) | Defensável e 100% AWS, mas a modelagem relacional de regras, versões, aprovação e auditoria e as consultas da API ficam mais custosas, e o ambiente local é menos simples. O GSI é eventualmente consistente |
| DynamoDB Streams como *outbox* | Põe dois saltos (stream e Lambda) no caminho crítico do alerta |

## Consequências

- Unicidade e *outbox* atômicos por transação; consultas da API (por id e por status) triviais.
- Cada instância usa um *pool* de conexões; em produção, PgBouncer ou RDS Proxy. O Postgres é ponto único no caminho do alerta, mitigado por Multi-AZ (RF-43: sem banco, o evento volta à fila).
- **Retenção de 5 anos (P-20):** no limite superior são centenas de milhões a mais de um bilhão de alertas por ano. A evolução é particionar `alerts` por mês e arquivar partições antigas em S3. Atenção: no Postgres, uma restrição `UNIQUE` em tabela particionada precisa incluir a chave de partição, o que quebraria a unicidade entre meses. A solução é uma tabela pequena `alert_dedupe (dedupe_key PK, created_at)`, com expurgo após o prazo de reprocessamento (a DLQ retém 14 dias, P-21), mantendo `alerts` sem `UNIQUE` global. No desafio isso fica **desenhado, não implementado**.
- No desafio, a consulta de alertas se limita a buscar por id e atualizar o status (RF-38 reduzido); a listagem com filtros fica documentada.

## Gatilhos de revisão

Volume de alertas uma ordem de grandeza acima do previsto, exigência de arquitetura 100% *serverless*, ou gargalo de escrita medido no k6.
