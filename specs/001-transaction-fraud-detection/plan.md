# Implementation Plan: Detecção de Fraude em Transações (Ingestão, Validação e Alertas)

**Branch**: `001-transaction-fraud-detection` | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-transaction-fraud-detection/spec.md`

## Summary

O motor consome eventos `TransactionEvent v1` da SQS, valida contra o contrato, avalia regras stateless
(carregadas de configuração versionada na inicialização) e, havendo suspeita, gera **um único** alerta
`FraudAlert v1` por transação.

A publicação dos alertas usa o **transactional outbox pattern** com publicação imediata: na mesma
transação Postgres gravam-se `alerts` (unicidade por `dedupe_key`) e `outbox`; após o `COMMIT`, o próprio
caso de uso publica a mensagem no **SNS FIFO `alerts.fifo`** e marca a linha do outbox como publicada
(caminho rápido, sem esperar polling). Um *relay* em segundo plano varre linhas pendentes
(`published_at IS NULL`, `FOR UPDATE SKIP LOCKED`) e republica as que falharam, garantindo entrega
*at-least-once*. O SNS faz fan-out para **uma fila SQS FIFO por canal** (interno e cliente); cada canal
tem um consumidor independente, com `deliveryId` estável, retentativa com espera crescente e DLQ.

Detalhes: [research.md](research.md) · [data-model.md](data-model.md) · [contracts/](contracts/) · [quickstart.md](quickstart.md)

## Technical Context

**Language/Version**: TypeScript 5.7 sobre Node.js ≥ 22

**Primary Dependencies**: NestJS 11, `pg`, `@aws-sdk/client-sqs` (já instalado), `@aws-sdk/client-sns` (nova; justificada em research.md D-02), `ajv` + `ajv-formats` (validação de contrato em runtime; hoje só devDependency, passa a dependency)

**Storage**: PostgreSQL 16 (`alerts`, `outbox`, `deliveries`); Redis fora do caminho desta feature (decisão stateless, FR-011)

**Testing**: Jest (unitário em `src/**/*.spec.ts`), integração com LocalStack/Postgres (`test/integration`, `npm run test:int`), e2e (`test/*.e2e-spec.ts`), `npm run contracts:validate`

**Target Platform**: Linux (contêiner Docker), AWS SQS/SNS (LocalStack 3.8 localmente)

**Project Type**: Serviço backend único (worker de filas + endpoints de saúde)

**Performance Goals**: 8.000 TPS sustentados (picos de 25 mil); alerta publicado ≤ 500 ms p99 desde o aceite na SQS (SC-004)

**Constraints**:
- Decisão estritamente stateless (FR-010/011)
- Evento só é removido da fila após resultado durável (FR-002, FR-019)
- Falha de um canal não afeta o outro nem a detecção (FR-021)
- Publicação no SNS fora da transação do banco, mas após o commit (outbox); falha de SNS não perde alerta nem derruba a detecção
- Sem PII em logs/métricas (FR-027)

**Scale/Scope**: 3 casos de uso (processar evento, publicar outbox, entregar a canal); 2 canais (fila antifraude e push ao cliente); 4 regras de exemplo

## Constitution Check

*GATE: avaliado antes da Fase 0 e reavaliado após a Fase 1.*

| Princípio | Avaliação | Observação |
|-----------|-----------|------------|
| I. Hexagonal | ✅ | `EventBus` (SNS), `AlertRepository` (outbox) e `NotificationProvider` já existem como portas; adaptadores ficam em `infrastructure/` |
| II. Contratos primeiro | ✅ | Usa `FraudAlert v1`, `AlertDelivery v1`, `DlqMessage v1` existentes; topologia SNS/SQS documentada em [contracts/messaging.md](contracts/messaging.md); nenhuma mudança incompatível |
| III. Idempotência | ✅ | `dedupe_key` UNIQUE no Postgres; `MessageDeduplicationId` no SNS FIFO; `deliveryId` estável no canal |
| IV. Resiliência | ✅ | Timeout + retry com backoff em SNS e canais; relay cobre falha de publicação; DLQ por etapa; testes de falha previstos |
| V. Desempenho | ⚠️ → ✅ | Publicação imediata evita latência de polling; alertas são fração do TPS de entrada. Risco de teto do SNS FIFO registrado em research.md D-06; verificar em teste de carga |
| VI. Regras sem redeploy | ⚠️ Desvio já aceito na spec | A spec limita a feature a regras em configuração versionada carregada na inicialização (FR-014a, Assumptions). Não afeta esta decisão; `RuleEngine` permanece como porta |
| VII. Segurança/observabilidade | ✅ | TLS/SSE em SNS/SQS, sem PII em log, métricas de outbox pendente e entregas |

**Resultado**: sem violações injustificadas. O desvio do Princípio VI é de escopo (declarado na spec), não de arquitetura.

**Reavaliação pós-design**: mantida. A introdução de `@aws-sdk/client-sns` é justificada (D-02); nenhuma complexidade extra além do relay, que é parte do padrão outbox.

## Project Structure

### Documentation (this feature)

```text
specs/001-transaction-fraud-detection/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── messaging.md
└── tasks.md             # gerado por /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── domain/
│   ├── alert/                     # FraudAlert, dedupeKey, consolidação de decisão
│   ├── rule/                      # regras stateless
│   └── transaction/               # TransactionEvent
├── application/
│   ├── ports/                     # AlertRepository, EventBus, NotificationProvider, RuleEngine, ...
│   └── use-cases/
│       ├── process-transaction.ts # valida → decide → saveWithOutbox → publica imediato
│       ├── relay-outbox.ts        # varre pendentes e republica
│       └── deliver-alert.ts       # consumo por canal, deliveryId, retry, DLQ
└── infrastructure/
    ├── messaging/
    │   ├── sqs-transaction.consumer.ts
    │   ├── sns-event-bus.ts       # adaptador de EventBus
    │   ├── sqs-channel.consumer.ts
    │   └── sqs-dlq.publisher.ts
    ├── persistence/
    │   ├── postgres-alert.repository.ts   # existente; ganha tratamento de tentativas do outbox
    │   └── migrations/002_outbox_relay.sql
    └── channels/                  # provedores: fila antifraude e push (simulado)

test/
├── integration/                   # outbox + SNS→SQS no LocalStack, falha de SNS, concorrência
└── *.e2e-spec.ts

infra/localstack/init-aws.sh       # já cria alerts.fifo + filas por canal; ganha DLQs de entrega
```

**Structure Decision**: serviço único, mantendo o layout hexagonal já presente no repositório. A infraestrutura do SNS FIFO e das filas por canal já existe no `init-aws.sh`; o plano acrescenta DLQs de entrega e migração do outbox.

## Complexity Tracking

Nenhuma violação a justificar.
