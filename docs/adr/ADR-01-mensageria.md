# ADR-01 — Mensageria

> Status: **proposto** · Data: 07/10/2026 · Premissas: P-10 a P-12, P-18, P-42 · Requisitos: RF-01, RF-02, RF-36, RNF-08, RNF-12

## Contexto

O motor consome 8.000 TPS sustentados (picos de 25.000) e precisa publicar o alerta em p99 ≤ 500 ms, contados desde o aceite do evento no barramento (P-12). O enunciado não pede *replay*; a DLQ cobre o reprocessamento de falhas. A contagem de janela da fase 2 não depende de ordem estrita (ADR-02). Os contratos são independentes de broker.

## Decisão

- **Entrada:** fila SQS padrão `transactions`, com DLQ `transactions-dlq` (retenção de 14 dias, P-21). O `accountId` viaja como atributo da mensagem e segue como chave lógica de partição (P-18).
- **Saída:** tópico SNS FIFO `alerts.fifo` (`MessageDeduplicationId = alertId`, `MessageGroupId = accountId`) e uma fila SQS FIFO por canal (`alert-deliveries-<canal>`), cada uma com DLQ própria.
- **Consumo:** em lote, com o lote processado em paralelo. O *ack* só acontece depois de persistir e publicar (RNF-12).
- ***Visibility timeout*:** de 3 a 5 vezes o p99 de processamento medido no k6, com piso de alguns segundos. Nos erros, recuo exponencial com `ChangeMessageVisibility` e `maxReceiveCount` alto, para que uma indisponibilidade curta do banco não leve mensagens à DLQ (RF-43).
- **Local:** LocalStack. A porta `EventBus` isola o broker.

## Alternativas consideradas

| Alternativa | Por que não agora |
|-------------|-------------------|
| Kafka / MSK | Dá *replay* e ordem por partição, mas custa mais operação e setup, e nenhum dos dois é exigido |
| Kinesis | Ordem por *shard* e retenção curta; não agrega ao que o desafio avalia |
| SQS FIFO na entrada | Os limites de vazão por fila e por grupo precisam ser conferidos para 25k TPS, e a ordem estrita não é necessária |

## Consequências

- Operação mínima e custo baixo, fácil de validar com k6 na AWS.
- Sem ordem estrita nem *replay* na entrada.
- A deduplicação do SNS FIFO vale só 5 minutos: serve para republicações rápidas e **não substitui** a restrição de unicidade no banco (ADR-02). Consumidores de alertas devem ser idempotentes por `alertId`.
- A cota de publicação do SNS FIFO na região precisa ser confirmada. O pico esperado (~125 alertas/s) deve caber com folga.

## Gatilhos de revisão

Exigência de *replay* ou de ordem estrita por conta, ou limite de vazão do SNS/SQS FIFO abaixo do necessário. Nesse caso, avaliar Kafka/MSK; nenhum payload dos contratos muda.
