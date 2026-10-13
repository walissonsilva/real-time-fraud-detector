# ADR-01 — Mensageria

> Status: **aceito** · Data: 07/10/2026 (revisado em 12/10/2026 para refletir a implementação) · Premissas: P-10 a P-12, P-18, P-42 · Requisitos: RF-01, RF-02, RF-36, RNF-08, RNF-12

## Contexto

O motor consome 8.000 TPS sustentados (picos de 25.000) e precisa publicar o alerta em p99 ≤ 500 ms, contados desde o aceite do evento no barramento (P-12). O enunciado não pede *replay*; a DLQ cobre o reprocessamento de falhas. Os contratos são independentes de broker.

## Decisão

- **Entrada:** fila SQS padrão `transactions`, com DLQ `transactions-dlq` (retenção de 14 dias, P-21) e *redrive* nativo em `maxReceiveCount = 10` como segunda rede. O `accountId` viaja no corpo do evento e, no tópico de saída, como `MessageGroupId`. O `ingestedAt` vem do `SentTimestamp` do SQS (P-12).
- **Saída:** tópico SNS FIFO `alerts.fifo` (`MessageGroupId = accountId`, `MessageDeduplicationId = dedupeKey`, `content_based_deduplication = false`) e uma fila SQS FIFO por canal assinante: `alert-deliveries-antifraud-queue.fifo` e `alert-deliveries-customer-push.fifo`. O SMS é *fallback* do push e sai pelo consumidor do canal do cliente (ADR-05), sem fila própria. O tópico e as filas usam o modo de **alta vazão por grupo de mensagens** (`fifo_throughput_scope = MessageGroup`, `perMessageGroupId`).
- **DLQ dos canais:** filas `*-dlq.fifo` (14 dias) **escritas pela aplicação** com `DlqMessage` (motivo e original), sem *redrive* nativo, para registrar o motivo da falha.
- **Consumo:** 4 *pollers* por instância (`SQS_TRANSACTION_POLLERS`), lotes de até 10 mensagens, *long polling* de 2 s (curto, para o desligamento terminar o que está em voo), processados em paralelo no lote. A mensagem só é excluída depois que o alerta e o *outbox* foram gravados; se a publicação no SNS falhar, a linha fica pendente e o relay republica (ADR-04).
- ***Visibility timeout*:** 10 s na fila de entrada (acoplado ao código: o recuo das retentativas usa `ChangeMessageVisibility`) e 30 s nas filas de canal. O recuo e as tentativas estão em [ADR-05](ADR-05-estrategia-de-degradacao.md).
- **Isolamento do broker:** o `SnsEventBus` e o consumidor SQS são classes concretas injetadas pelos módulos NestJS; não há porta abstrata `EventBus`. A troca de broker alteraria essas duas classes, não o domínio nem os contratos.
- **Local:** LocalStack, com a topologia em `infra/localstack/init-aws.sh`.

## Alternativas consideradas

| Alternativa | Por que não agora |
|-------------|-------------------|
| Kafka / MSK | Dá *replay* e ordem por partição, mas custa mais operação e setup, e nenhum dos dois é exigido (ver também [ADR-06](ADR-06-outbox-cdc-debezium.md)) |
| Kinesis | Ordem por *shard* e retenção curta; não agrega ao que o desafio avalia |
| SQS FIFO na entrada | Os limites de vazão por fila e por grupo precisam ser conferidos para 25k TPS, e a ordem estrita não é necessária |

## Consequências

- Operação mínima e custo baixo, validado com k6 na AWS.
- Sem ordem estrita nem *replay* na entrada.
- A deduplicação do SNS FIFO vale só 5 minutos: serve para republicações rápidas e **não substitui** a restrição de unicidade no banco (ADR-02). Consumidores de alertas devem ser idempotentes por `alertId` e por `deliveryId`.
- O modo de alta vazão por grupo tira o limite por tópico do caminho, mas a vazão por `accountId` (grupo) segue limitada; contas com tráfego muito concentrado serializam as entregas.
- **Evidência de vazão:** a 1.000 TPS (≈ 10 alertas/s, taxa de 1%) o p99 de serviço ficou entre 122 e 242 ms e não houve duplicados ([registro](../registro-testes-aws.md)). A 4.000 TPS (≈ 40 alertas/s, 1% de alertas) o p99 de serviço foi de 174 ms, sem duplicados, sem mensagens em DLQ e com 0 falhas de entrega no SNS. A taxa de alertas do pico de projeto (~125/s) e a cota do SNS FIFO na região **não foram medidas**: 8.000 TPS e a rajada de 25k não foram executados por limite de cotas e do gerador.

## Gatilhos de revisão

Exigência de *replay* ou de ordem estrita por conta, ou limite de vazão do SNS/SQS FIFO abaixo do necessário em teste de carga acima de 4.000 TPS. Nesse caso, avaliar Kafka/MSK; nenhum payload dos contratos muda.
