# Contratos

> Status: **rascunho v0.1** · Premissas: [01-premissas.md](../01-premissas.md) · RF: [02](../02-requisitos-funcionais.md) · RNF: [03](../03-requisitos-nao-funcionais.md)
> Os contratos são **independentes de broker** (ADR-01 em aberto). Nomes de tópicos/filas abaixo são lógicos.

## 1. Índice

| # | Contrato | Tipo | Fluxo | Arquivo |
|---|----------|------|-------|---------|
| 1 | `TransactionEvent v1` | Evento (entrada) | Serviços de origem → motor | [transaction-event.v1.schema.json](transaction-event.v1.schema.json) |
| 2 | `Rule v1` | Dado / API | Admin de regras → repositório → motor | [rule.v1.schema.json](rule.v1.schema.json) |
| 3 | `FraudAlert v1` | Evento (saída) | Motor → canais e consumidores | [fraud-alert.v1.schema.json](fraud-alert.v1.schema.json) |
| 4 | API HTTP v1 | OpenAPI 3.1 | Ingestão (opcional), regras, canais, alertas, saúde | [openapi.v1.yaml](openapi.v1.yaml) |
| 5 | `AlertDelivery v1` | Mensagem interna | Roteador → adaptador de canal | [alert-delivery.v1.schema.json](alert-delivery.v1.schema.json) |
| 6 | `DlqMessage v1` | Envelope | Qualquer etapa → DLQ → *redrive* | [dlq-message.v1.schema.json](dlq-message.v1.schema.json) |
| 7 | Webhook de saída | Convenção HTTP | Motor → sistema antifraude interno | seção 5 abaixo |

Exemplos válidos e inválidos estão em [examples/](examples/). Convenção de nome: `<contrato>.<caso>.valid.json` deve passar; `.invalid.json` deve falhar. Para conferir: `node docs/contratos/validate-contracts.mjs` (precisa de `ajv` e `ajv-formats`; vira teste de contrato na CI, RNF-51).

## 2. Fluxo lógico

```
produtores ──▶ [transactions.v1] ──▶ validação ──▶ avaliação de regras ──▶ persistência + outbox
 (ou POST /v1/transactions)             │ inválido                               │
                                        ▼                                        ▼
                                  [transactions.dlq]                     [alerts.v1] (FraudAlert)
                                                                                 │ roteamento (política de canais)
                                                                                 ▼
                                                              [alert-deliveries.v1.<canal>] (AlertDelivery)
                                                                                 │ adaptador por canal
                                                           ┌─────────────────────┴───────────────┐
                                                     interno (fila/webhook)               externo (push/SMS/e-mail)
                                                                   falha após retries ──▶ [*.dlq] (DlqMessage)
```

## 3. Convenções

- JSON UTF-8. Campos em `camelCase`; enums em `UPPER_SNAKE_CASE`.
- Datas e horas: RFC 3339 em UTC, com milissegundos (`2026-10-03T14:21:07.412Z`).
- Dinheiro: `{ minorUnits: inteiro, currency: ISO 4217 }`. Nunca ponto flutuante.
- Identificadores de pessoa, conta e instrumento são **tokens opacos**. Nunca PAN, CPF ou nome em claro (P-31, RNF-24).
- Erros HTTP em `application/problem+json` (RFC 9457), com `traceId`, sem PII e sem eco do payload.
- Os schemas usam `additionalProperties: false`: campo desconhecido é rejeitado (protege contra vazamento de PII por campo extra). Extensão pequena e livre só em `attributes`.

### Metadados de mensagem (qualquer broker)

| Metadado | Valor |
|----------|-------|
| `content-type` | `application/json` |
| `schema-version` | Igual a `schemaVersion` do corpo, para roteamento sem *parse* |
| `traceparent` | W3C Trace Context, propagado de ponta a ponta (RNF-43) |
| `message-id` | `eventId` / `alertId` / `deliveryId` |
| Chave de particionamento | `accountId` nas filas de transação e de alerta (P-18); `deliveryId` nas filas de entrega |

### Marcos de tempo e medição de latência

| Marco | Significado | Fonte |
|-------|-------------|-------|
| `occurredAt` | Quando a transação ocorreu | Produtor (só para janelas, P-19) |
| `ingestedAt` | **O barramento aceitou o evento.** Início do SLO de 500 ms | Timestamp do broker (`SentTimestamp` no SQS, *LogAppendTime* no Kafka); no HTTP, recebimento na API |
| `consumedAt` | O motor iniciou o processamento | Relógio do motor |
| `detectedAt` | Decisão de regras concluída | Relógio do motor |
| `publishedAt` | Alerta persistido e publicado. Fim do SLO | Relógio do motor |

`latencyMs = publishedAt − ingestedAt` **inclui a espera na fila**; `consumedAt − ingestedAt` isola a fila. O relógio do produtor não entra na medição. Como `ingestedAt` vem do broker e os demais do motor, os relógios precisam estar sincronizados (NTP / Amazon Time Sync); desvio acima de alguns ms deve gerar alarme.

## 4. Semântica de entrega e idempotência

Entrada *at-least-once*, consumidor idempotente e *outbox* dão alerta efetivamente único (RNF-14). Cada fronteira tem a sua chave:

| Fronteira | Chave de idempotência | Onde é garantida |
|-----------|----------------------|------------------|
| Evento de entrada | `transactionId` + `eventType` (P-03) | Cache de dedupe (otimização) |
| **Alerta** | `dedupeKey = sha256("fraud-alert:v1:" + transactionId)` | **Restrição de unicidade no armazenamento** (RNF-15); o cache não basta |
| Entrega a um canal | `deliveryId = sha256("alert-delivery:v1:" + alertId + ":" + canal)` | Adaptador de canal; estável entre *retries* |
| Webhook / provedor externo | `Idempotency-Key = alertId` | Receptor |
| Reprocessamento da DLQ | Mesmas chaves acima; `redriveCount` limita ciclos | Idêntica ao fluxo normal |
| Regra | `ruleId` + `version` (imutável) | Repositório de regras |

Consequência para os produtores: reenviar o mesmo evento é seguro. Reenviar com `transactionId` novo cria uma transação nova.

## 5. Webhook de saída (alerta ao sistema antifraude)

`POST <url cadastrada>` com o `FraudAlert v1` no corpo.

| Cabeçalho | Conteúdo |
|-----------|----------|
| `Idempotency-Key` | `alertId` |
| `X-Delivery-Id` | `deliveryId` |
| `X-Signature` | `t=<unix>,v1=<hex>`; `hex` = HMAC-SHA256 de `"<t>." + corpo` com segredo por receptor (rotacionável, no secret manager) |
| `traceparent` | Trace Context |

- Transporte: mTLS. O receptor deve rejeitar `t` com mais de 5 minutos e deduplicar por `alertId`.
- Resposta esperada: `2xx` em até 2 s. `408`, `429` e `5xx` ou *timeout* → *retry* exponencial com *jitter*. Outros `4xx` → sem retry, vai para a DLQ com `PROVIDER_REJECTED`.
- *Circuit breaker* por receptor (RF-36, RNF-17).

## 6. Autorização da API

| Papel | Escopos | Pode |
|-------|---------|------|
| `producer` | `transactions:write` | Enviar eventos |
| `fraud-rules-admin` | `rules:read`, `rules:write`, `channels:admin` | Criar/editar regras, rollback, kill switch, política e estado de canais |
| `fraud-rules-approver` | `rules:read`, `rules:approve` | Aprovar/rejeitar versões; **autor ≠ aprovador** (P-34) |
| `fraud-analyst` | `alerts:read`, `alerts:write` | Consultar alertas e mudar status |

Autenticação: OAuth2 *client credentials* com JWT curto (≤ 15 min) sobre mTLS (RNF-22). Toda mudança de regra, status de alerta, canal ou política entra na trilha de auditoria imutável (RNF-28).

## 7. Classificação de dados (LGPD)

Token opaco **continua sendo dado pessoal** quando permite reidentificação (pseudonimização, LGPD art. 13, §4º); por isso entra em log somente de forma controlada.

| Campo | Classe | Tratamento |
|-------|--------|-----------|
| `customerId`, `accountId`, `instrumentToken`, `counterparty.idToken` | Pseudonimizado | Pode trafegar e ser persistido; fora de métricas (cardinalidade e privacidade); em log só o necessário |
| `origin.deviceIdHash` | Pseudonimizado | Idem |
| `origin.ipAddress` | Dado pessoal | Opcional; persistir truncado ou com hash; **nunca** em log |
| `origin.geo` | Dado pessoal (localização) | Usado só para regras; **não** vai para o alerta; precisão reduzida ao persistir |
| `amount`, `transactionType`, `channel` | Dado transacional | Necessário à finalidade |
| `attributes` | Livre | Proibido PII; revisão obrigatória antes de virar campo tipado |
| `DlqMessage.original` | Pode conter qualquer campo acima | Cifrado, acesso restrito, retenção 14 dias (P-21) |

## 8. Evolução e compatibilidade

- Versão no nome do contrato (`v1`) e no campo `schemaVersion` (`1.x`).
- **Compatível (minor, `1.x`)**: adicionar campo opcional; adicionar valor a *enum* de **saída** (consumidores devem tolerar valores novos); relaxar restrição.
- **Incompatível (novo major, `v2`)**: remover ou renomear campo, tornar campo obrigatório, mudar tipo ou semântica, restringir *enum* de entrada.
- Como o schema de entrada é estrito, **o motor atualiza o schema antes dos produtores** (consumidor primeiro). O motor aceita `1.*` e envia à DLQ com `UNSUPPORTED_VERSION` qualquer outro major.
- `v1` e `v2` convivem por no mínimo um ciclo de migração; cada contrato novo tem exemplos e testes de contrato.
- Campos novos estáveis em `attributes` devem virar campos tipados na próxima minor.

## 9. Pontos de atenção (decisões pendentes)

1. **Escopo das regras com janela (P-08):** `Rule v1` já suporta `kind: WINDOWED`, mas na fase 1 o motor rejeita essas regras na validação (RF-18, RF-26). A fase 2 ativa só a velocidade (`COUNT`). **"Viagem impossível"** não é expressável hoje (as agregações `COUNT`, `SUM`, `DISTINCT_COUNT` e `MAX` não guardam o último ponto geográfico) e está fora de escopo; se um dia entrar, precisa da agregação `LAST` e da função `distanceKm` na linguagem de expressão (ADR-03).
2. **Estorno após alerta (P-07)**: hoje o disparo posterior não gera novo alerta nem atualiza o existente. Se o time antifraude quiser ver isso, adicionar evento `alert.updated`.
3. **Limites da API de ingestão** (tamanho 16 KiB, taxa por produtor): valores iniciais; confirmar no teste de carga.
4. **Retenção e *replay***: o enunciado não pede *replay*; a DLQ cobre reprocessamento de falhas. Se ADR-01 escolher SQS, nenhum contrato muda.
