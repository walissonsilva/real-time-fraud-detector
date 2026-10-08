# Phase 1 — Data Model

Entidades de domínio: ver [spec.md](spec.md#key-entities). Esta seção cobre o modelo de persistência afetado pelo outbox. Esquema base em `src/infrastructure/persistence/migrations/001_init.sql`.

## alerts (existente)

| Campo | Observação |
|-------|-----------|
| `alert_id` uuid PK | |
| `dedupe_key` text UNIQUE | `sha256("fraud-alert:v1:" + transactionId)`; garante no máximo um alerta por transação (FR-017) |
| `published_at` timestamptz null | Preenchido após a publicação bem-sucedida no SNS |
| demais colunas | severidade, pontuação, regras, resumo, marcos de tempo |

## outbox (existente + migração `002_outbox_relay.sql`)

| Campo | Tipo | Observação |
|-------|------|-----------|
| `alert_id` | uuid PK, FK `alerts` | uma linha por alerta |
| `payload` | jsonb | `FraudAlert v1` completo, exatamente o que será publicado |
| `created_at` | timestamptz | |
| `published_at` | timestamptz null | `NULL` = pendente |
| **`attempts`** (novo) | integer default 0 | tentativas de publicação |
| **`last_error`** (novo) | text null | código do erro, sem PII |
| **`next_attempt_at`** (novo) | timestamptz | backoff do relay |
| **`traceparent`** (novo) | text null | propagação do rastreamento (FR-029) |

Índice parcial existente `outbox_pending_idx (created_at) WHERE published_at IS NULL`; a migração o substitui por um índice em `next_attempt_at` com o mesmo filtro.

### Estados da linha do outbox

```
PENDENTE (published_at NULL) ──publicação imediata ok──▶ PUBLICADA
        │ falha
        ▼
PENDENTE (attempts+1, next_attempt_at com backoff) ──relay ok──▶ PUBLICADA
```

Não há estado terminal de falha: o relay continua tentando, e a idade da linha mais antiga dispara alarme (D-07).

### Regras de consistência

1. `INSERT alerts` e `INSERT outbox` ocorrem na mesma transação; conflito em `dedupe_key` faz rollback e retorna `false` (sem outbox novo).
2. A publicação no SNS ocorre **após** o commit, nunca dentro da transação.
3. `markPublished` atualiza `outbox.published_at` e `alerts.published_at` na mesma transação; é idempotente.
4. O relay usa `FOR UPDATE SKIP LOCKED`, de modo que instâncias concorrentes não processam a mesma linha.
5. `publishedAt` do alerta (marco de latência, FR-018) é o instante do aceite do SNS.

## deliveries (existente)

| Campo | Observação |
|-------|-----------|
| `delivery_id` text PK | `sha256("alert-delivery:v1:" + alertId + ":" + canal)`; estável entre retentativas |
| `alert_id` FK, `channel` | |
| `status` | `PENDING` → `DELIVERED` ou `DEAD_LETTERED` |
| `attempts`, `last_error`, `updated_at` | |

Criada pelo consumidor do canal com `INSERT … ON CONFLICT DO NOTHING`; entrega já `DELIVERED` não é reenviada.
