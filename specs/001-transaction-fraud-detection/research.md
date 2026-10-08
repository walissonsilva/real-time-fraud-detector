# Phase 0 — Research

Não restaram itens `NEEDS CLARIFICATION`. As decisões abaixo registram as escolhas, incluindo a diretriz do usuário para a publicação de alertas.

## D-01 — Outbox transacional com publicação imediata + relay

- **Decision**: Na mesma transação Postgres, inserir `alerts` e `outbox`. Após o `COMMIT`, o caso de uso publica no SNS e atualiza `outbox.published_at`/`alerts.published_at`. Um relay periódico republica linhas com `published_at IS NULL` mais antigas que um limiar curto.
- **Rationale**: Atende à diretriz "salvar o evento no outbox e já publicá-lo". O commit atômico elimina a janela "alerta gravado, mensagem perdida"; a publicação imediata mantém a latência dentro de 500 ms; o relay cobre crash entre commit e publish ou indisponibilidade do SNS. O `claimPendingOutbox` já existe no repositório com `FOR UPDATE SKIP LOCKED`.
- **Alternatives**: (a) publicar no SNS antes de gravar: pode publicar alerta que nunca foi persistido; (b) só relay por polling: adiciona latência de polling ao SLO; (c) CDC (Debezium): infraestrutura extra desproporcional.
- **Consequência**: publicação *at-least-once*; duplicatas são absorvidas por `MessageDeduplicationId` (janela de 5 min do SNS FIFO) e pela idempotência por `deliveryId` nos consumidores.

## D-02 — SNS FIFO como barramento de saída, com fan-out para SQS por canal

- **Decision**: Tópico `alerts.fifo` (`ContentBasedDeduplication=false`). `MessageGroupId = accountId`; `MessageDeduplicationId = dedupeKey`. Inscrições SQS FIFO com `RawMessageDelivery=true`, uma fila por canal (`alert-deliveries-antifraud-queue.fifo`, `alert-deliveries-customer-push.fifo`). Adiciona `@aws-sdk/client-sns`.
- **Rationale**: O fan-out dá isolamento por canal (FR-021): fila, consumidor, retentativas e DLQ próprios. Novo canal = nova inscrição, sem mudar o produtor. FIFO preserva ordem por conta e dedupe de publicação.
- **Alternatives**: publicar direto em duas filas (acopla o produtor aos canais e perde atomicidade entre as duas publicações); SNS padrão (sem dedupe de publicação).

## D-03 — Consumidor de canal deriva o `AlertDelivery`

- **Decision**: As filas por canal recebem o `FraudAlert v1` bruto. O consumidor calcula `deliveryId = sha256("alert-delivery:v1:" + alertId + ":" + canal)`, registra a entrega em `deliveries` (`INSERT … ON CONFLICT DO NOTHING`) e monta o `AlertDelivery v1`. Para o cliente, só tipo, valor formatado e data entram em `template.params`; regras, pontuação, severidade e evidências não são enviadas ao provedor (FR-025).
- **Rationale**: Evita um roteador intermediário adicional; a política de canais é fixa nesta feature.
- **Risco aceito**: a fila do cliente carrega o alerta completo dentro da infraestrutura interna; o filtro de conteúdo ocorre no adaptador. Mitigação futura: política de filtro na inscrição ou mensagem reduzida.

## D-04 — Completar entregas pendentes na reentrega (FR-017a)

- **Decision**: Reentrega do evento de entrada com alerta existente: `saveWithOutbox` retorna `false`. O caso de uso confirma o evento, e, se a linha do outbox ainda estiver pendente, republica. Entregas aos canais pendentes são completadas pelos consumidores de canal (filas por canal já guardam a mensagem; `deliveries` evita repetir as concluídas).
- **Rationale**: Mantém um único alerta e não repete entregas concluídas.

## D-05 — Retentativas e DLQ

- **Decision**:
  - Entrada: até 3 retentativas com espera crescente via `ChangeMessageVisibility` (contagem por `ApproximateReceiveCount`); ao esgotar, publicar `DlqMessage v1` (`MAX_RETRIES_EXCEEDED`, etapa `PERSISTENCE` ou `ALERT_PUBLISH`) em `transactions-dlq` e remover a original. Rejeições de validação vão direto à DLQ com `SCHEMA_INVALID`, `DESERIALIZATION_ERROR` ou `UNSUPPORTED_VERSION`.
  - Publicação SNS: timeout curto e retry com backoff e jitter dentro da chamada imediata; se falhar, **não** falha o processamento do evento, pois o alerta já está durável e o relay assume.
  - Entrega a canal: timeout, retry com backoff; ao esgotar, `DlqMessage` com `CHANNEL_DELIVERY` em DLQ própria do canal.
- **Ajuste de infra**: `maxReceiveCount` da fila de entrada passa a ser rede de segurança acima de 3 retentativas aplicativas; criar DLQs `alert-deliveries-*-dlq.fifo`.

## D-06 — Teto de vazão do SNS FIFO

- **Decision**: Aceitar o SNS FIFO. Alertas são fração do tráfego de entrada, e `MessageGroupId = accountId` distribui a carga.
- **Risco**: tópicos FIFO têm limite de publicação por tópico (modo de alta vazão eleva). Validar no teste de carga; se o teto for atingido, habilitar modo de alta vazão ou particionar por tópico.

## D-07 — Observabilidade do outbox

- **Decision**: Métricas: `outbox_pending` (gauge), `outbox_publish_total{result}`, `outbox_relay_republished_total`, idade da linha pendente mais antiga. Logs estruturados com `alertId` e `traceId`, sem PII. Readiness não depende do SNS (degradação controlada).
