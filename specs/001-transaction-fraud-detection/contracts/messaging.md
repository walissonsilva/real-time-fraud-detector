# Contrato de mensageria da publicação de alertas

Os formatos de corpo são os contratos existentes em `docs/contratos/` (`FraudAlert v1`, `AlertDelivery v1`, `DlqMessage v1`); este documento define apenas a topologia e os atributos de mensagem. Nenhum schema novo ou alterado.

## Topologia

```
Postgres (alerts + outbox, mesma transação)
        │ commit
        ├─▶ publicação imediata ─┐
        └─▶ relay (pendentes) ───┤
                                 ▼
                       SNS FIFO  alerts.fifo
                         ├─▶ SQS FIFO alert-deliveries-antifraud-queue.fifo ─▶ consumidor ─▶ canal interno
                         └─▶ SQS FIFO alert-deliveries-customer-push.fifo   ─▶ consumidor ─▶ canal cliente (simulado)
                                          falha após retries ─▶ DLQ do canal (DlqMessage, CHANNEL_DELIVERY)
```

## Publicação no SNS

| Item | Valor |
|------|-------|
| Tópico | `alerts.fifo` (`SNS_ALERTS_TOPIC`) |
| Corpo | `FraudAlert v1` (JSON) |
| `MessageGroupId` | `accountId` |
| `MessageDeduplicationId` | `dedupeKey` |
| Atributos | `schema-version` = `schemaVersion`; `message-id` = `alertId`; `traceparent` quando houver |
| Assinaturas | SQS FIFO, `RawMessageDelivery=true` |

## Garantias

- **At-least-once** na publicação; duplicatas absorvidas pela dedupe do SNS FIFO (5 min) e pelo `deliveryId` nos consumidores.
- Ordem preservada por conta (`MessageGroupId`).
- Falha do SNS não falha o processamento do evento de entrada: o alerta já está no outbox e o relay republica.

## Entrega por canal

- Consumidor calcula `deliveryId` (ver [data-model.md](../data-model.md)) e monta `AlertDelivery v1`.
- Canal interno: `ANTIFRAUD_QUEUE`, `audience = ANTIFRAUD_TEAM`. Canal cliente: `PUSH`, `audience = CUSTOMER`, `template.id = suspicious-transaction.v1`, `params` somente com tipo, valor formatado e data.
- Esgotadas as tentativas: `DlqMessage v1` com `stage = CHANNEL_DELIVERY`, `reasonCode = MAX_RETRIES_EXCEEDED`, `reasonDetail` sem PII.

## Configuração (`.env.example`)

Já existem `SNS_ALERTS_TOPIC`, `SQS_*` e `AWS_*`. Acrescentar: `OUTBOX_RELAY_INTERVAL_MS`, `OUTBOX_RELAY_MIN_AGE_MS`, `OUTBOX_RELAY_BATCH_SIZE`, `SNS_PUBLISH_TIMEOUT_MS`, nomes das filas de canal e de suas DLQs.
