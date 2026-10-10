# ADR-06 — Outbox com CDC (Debezium + Kafka) não substitui a publicação inline com relay

> Status: **proposto** · Data: 10/10/2026 · Relacionada: [ADR-01](ADR-01-mensageria.md), [ADR-04](ADR-04-armazenamento.md), [ADR-05](ADR-05-estrategia-de-degradacao.md) · Requisitos: RNF-04, RNF-12, RNF-17

## Contexto

Hoje o alerta segue o padrão *transactional outbox* com **publicação síncrona e relay como rede de segurança** (ADR-04): uma transação grava o alerta e a linha de *outbox*; depois do *commit* o serviço publica **inline** no SNS FIFO e marca `published_at`; um relay periódico republica o que ficou pendente (`OutboxEntryPublisherService`, `RelayOutboxService`, `OutboxRelayScheduler`). A entrega é *at-least-once* e o SNS FIFO absorve duplicatas pelo `dedupeKey`.

A alternativa avaliada é a captura de mudanças (CDC): o Debezium lê o WAL do Postgres (replicação lógica, `pgoutput`), usa o *Outbox Event Router* e publica os alertas no Kafka (MSK + MSK Connect, ou Debezium Server no ECS). A linha de *outbox* passaria a ser somente inserção, e o publisher inline e o relay deixariam de existir.

## Decisão

**Manter a publicação inline com relay de fallback (ADR-04). Não adotar Debezium + Kafka para este projeto.**

O CDC é uma alternativa tecnicamente válida e correta, mas **tende a ser menos eficiente** para este caso: ele acrescenta latência ao caminho do alerta, custo fixo e carga operacional, e resolve um problema (relay e dual-write) que aqui é pequeno.

> As comparações de latência abaixo são **estimativas de projeto**, não medições. Não houve protótipo nem teste de carga do CDC.

## Justificativa

### Latência (RNF-04)

| Aspecto | Inline + relay (atual) | Debezium + Kafka |
|---------|------------------------|------------------|
| Caminho até o barramento | Uma chamada direta ao SNS depois do *commit*, da ordem de 10 a 30 ms | *Commit* → WAL → slot de replicação → Connect → produtor Kafka (`acks=all`) → broker. Tipicamente dezenas de ms, com cauda (p99) de 100 a 300 ms por *batching*, GC e *rebalances* |
| Ajuste necessário | Nenhum | `poll.interval.ms` do Debezium (padrão 500 ms) precisa cair para ~10 a 50 ms |
| Salto extra | Nenhum | Um salto assíncrono entre o banco e o barramento, fora do controle do serviço |
| Ponto de medição do SLO | Aceite do SNS (`alert_latency_ms`), carimbado pelo próprio serviço | Chegada no Kafka ou consumo; o serviço perde a visibilidade direta |
| Campos `publishedAt`/`latencyMs` do contrato | Carimbados no envio | O *payload* é fixado no *insert*; os campos passariam a refletir o *commit*, não o envio, exigindo rever o contrato |

O CDC tira a chamada ao SNS do caminho do consumidor, o que reduz o tempo de processamento do evento. Mas o SLO é medido do ingresso até a disponibilização do alerta, e nessa medida o CDC soma um salto assíncrono em vez de remover trabalho. O orçamento de 100 ms para "persistência + *outbox*" não ganha folga que compense a cauda adicional.

### O problema que o CDC resolveria é pequeno aqui

- Volume de alertas de 8 a 40 por segundo, até ~125 em pico (ADR-04). A publicação inline e o relay dão conta com folga.
- O relay já existe, está testado (`relay-outbox.int-spec.ts`, `no-silent-loss.int-spec.ts`) e é simples: `FOR UPDATE SKIP LOCKED` e *backoff*.
- A garantia de não perder alerta vem da gravação transacional, que o CDC também usa. Ele não a melhora; só muda quem publica.

### Custo e operação

- **Piso fixo:** MSK (mínimo de brokers) e MSK Connect cobram por hora, sem relação com o volume. O SNS/SQS atual é *pay-per-use* e o perfil `lean` do projeto depende disso.
- **Replicação lógica no RDS:** exige `rds.logical_replication=1` (com *reboot*), usuário com `rds_replication` e monitoramento do slot.
- **Risco do slot:** se o *connector* parar, o slot retém WAL e pode encher o disco do RDS. É preciso `max_slot_wal_keep_size` e alarme de *lag* do slot.
- **Ciclo de vida:** os scripts de pausa e retomada do RDS e o comportamento do slot em *failover* Multi-AZ passam a ser pontos de atenção.
- **Mais componentes no caminho crítico:** Postgres → Connect → Kafka, cada um com seu modo de falha, contra Postgres → SNS hoje.

### Impacto no restante do desenho

- O fan-out SNS FIFO → SQS FIFO por canal (ADR-01) viraria *consumer groups*. *Retry* com *backoff*, *visibility timeout* e DLQ por canal, que o SQS entrega prontos, teriam de ser reconstruídos com tópicos de *retry* e DLQ.
- Sem tratamento, uma mensagem venenosa bloqueia a partição. No SQS ela só volta à fila.
- A ordem por conta (`MessageGroupId = accountId`) viraria chave de partição. A deduplicação do SNS FIFO sai, e os consumidores precisam ser idempotentes (já deveriam ser).
- Mudaria o código, o contrato e o Terraform, para um ganho que o desafio não pede.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Debezium + Kafka (esta ADR) | Mais latência na cauda, custo fixo, operação do slot e reconstrução do retry/DLQ por canal, sem ganho para o volume previsto |
| Relay próprio publicando em Kafka (sem Debezium) | Evita Connect e replicação lógica, mas ainda exige Kafka. Só faria sentido se Kafka virasse requisito |
| DynamoDB Streams como *outbox* | Já descartada na ADR-04: dois saltos (stream e Lambda) no caminho crítico |
| AWS DMS (CDC) para Kinesis ou MSK | Latência e operação piores que as do Debezium para este uso |

## Consequências

- Mantém-se o desenho da ADR-04 e da ADR-05 (SNS fora → alerta fica no *outbox*, relay republica).
- A publicação inline continua sendo uma otimização de latência; a garantia continua vindo da transação.
- O dual-write entre banco e barramento permanece como lógica de aplicação (publisher e relay), coberta por testes.
- Nenhuma mudança de código, contrato ou infraestrutura.

## Gatilhos de revisão

Reabrir esta decisão se:
- **Kafka** virar requisito de plataforma (replay, vários consumidores independentes, integração com outros times).
- O volume de alertas crescer uma ordem de grandeza ou mais, e o relay ou a publicação inline virarem gargalo medido no k6.
- Houver exigência de eliminar o dual-write da aplicação por política, não por desempenho.
- Um **protótipo medido** (commit → Kafka, p95/p99 a 1.000 TPS) mostrar latência igual ou menor que a da publicação inline.
