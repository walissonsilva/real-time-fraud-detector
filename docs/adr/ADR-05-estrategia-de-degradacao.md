# ADR-05 — Estratégia de degradação

> Status: **proposto** · Data: 07/10/2026 · Premissas: P-01 · Requisitos: RF-40 a RF-45, RNF-08, RNF-11, RNF-17, RNF-18

## Contexto

O motor é assíncrono e não bloqueante (P-01): perder detecção em silêncio é pior do que alertar com menos precisão. Falhas de dependências auxiliares não podem interromper a detecção (RNF-11), e nenhum evento aceito pode ser perdido (RNF-12).

## Decisão

| Dependência fora | Comportamento | Sinal |
|------------------|---------------|-------|
| **Repositório de regras** (Postgres, só leitura de regras) | Continua com a última versão válida em memória (RF-40) | Métrica de idade do conjunto de regras; alarme acima de 30 s |
| **Postgres** (gravação de alertas) | Eventos **sem alerta** seguem e recebem *ack*, pois não tocam o banco. Eventos **com alerta** não recebem *ack*, voltam à fila com recuo exponencial (`ChangeMessageVisibility`) e `maxReceiveCount` alto (RF-43) | `/health/ready` falha; alarme de idade da mensagem mais antiga |
| **SNS** (publicação do alerta) | *Retry* curto inline; se falhar, a linha fica no *outbox* e o relay republica | Contagem e idade do *outbox* pendente |
| **Redis** (fase 2) | Regras stateless seguem; regras com janela entram em modo degradado, ***fail-open***, e o alerta sai com `degraded=true` (RF-41) | Métrica `degraded_mode{dependency="redis"}` |
| **Provedor externo** | *Retry* exponencial com *jitter*, *circuit breaker* por provedor, *fallback* de canal (push → SMS) e DLQ. A detecção não é afetada (RF-36, RF-42) | Estado dos *breakers*, tamanho da DLQ |
| **Canal interno** (webhook) | Mesmo tratamento do provedor, com assinatura HMAC e `Idempotency-Key` | Taxa de entrega por canal |

**Regras gerais:**
- Todo I/O tem *timeout* explícito; *retry* só em operações idempotentes, com limite e *jitter* (RNF-18).
- Canais, provedores e DLQ têm filas e *pools* próprios (*bulkhead*, RNF-17).
- *Backpressure* (RNF-08): concorrência limitada por instância; sob sobrecarga o consumo desacelera em vez de perder eventos ou estourar a memória.
- *Graceful shutdown*: termina as mensagens em voo antes de encerrar (RF-45).
- *Kill switch* de regra e de canal, sem deploy (RF-53).

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| *Fail-closed* nas regras de janela | Interromperia detecção que as regras stateless ainda podem fazer, sem benefício, já que o motor não bloqueia transações |
| Descartar eventos quando o banco cai | Viola RPO = 0 (RNF-12) |

## Consequências

- Durante uma queda do Postgres, o *lag* da fila cresce, mas os eventos não são perdidos nem passam para a DLQ por tentativas esgotadas, graças ao recuo e ao `maxReceiveCount` alto.
- Alertas de regras de janela em modo degradado têm menos precisão e vêm marcados para o analista.

## Adendo (2026-10-12): circuit breaker, fallback de canal e kill switch implementados

Como ficou na entrega de alertas (`DeliverAlertService`, `src/shared/circuit-breaker.ts`). Diagramas de estados, fluxo de decisão e todos os cenários: [degradacao-de-canais.md](../degradacao-de-canais.md).

| Aspecto | Decisão |
|---------|---------|
| **Breaker** | Um por canal (`ANTIFRAUD_QUEUE`, `PUSH`, `SMS`), por falhas **consecutivas** (`CHANNEL_BREAKER_FAILURE_THRESHOLD`, padrão 5). Aberto por `CHANNEL_BREAKER_OPEN_MS` (30 s); depois deixa passar **uma** sonda (meio-aberto): sucesso fecha, falha reabre. Relógio monotônico. |
| **Escopo do estado** | Em memória, **por task**. Cada instância aprende sozinha (no pior caso, 3 tasks × 5 falhas). Estado compartilhado (Redis) fica como evolução; a vantagem é não criar dependência nova no caminho da entrega. |
| **Com breaker aberto** | Falha rápida, sem espera de backoff e sem tocar o provedor. |
| **Fallback** | Só no canal do cliente: `PUSH` → `SMS`, com `deliveryId` próprio (`sha256(alertId + ":SMS")`) e o mesmo conteúdo mínimo, sem PII. A linha do SMS só nasce quando ele entrega; o push fica `FALLBACK_DELIVERED`. O antifraude não tem fallback (o contrato proíbe cliente em canal interno e vice-versa). |
| **Sem entrega e breaker aberto** | Resultado `DEFERRED`: a mensagem **não** vai à DLQ; o consumidor ajusta a visibilidade (`ChangeMessageVisibility`) para o fim do cooldown e a fila drena sozinha na recuperação. |
| **Vai à DLQ** | (a) retentativas esgotadas com o breaker ainda fechado (`MAX_RETRIES_EXCEEDED`); (b) alerta vencido, `detectedAt` + 10 min sem entrega (`DELIVERY_EXPIRED`). |
| **Kill switch** | `CHANNEL_<ANTIFRAUD|CUSTOMER|SMS>_DISABLED=true` força o breaker aberto: o push cai direto no SMS, o antifraude fica adiado. É variável do serviço ECS: **exige novo deployment do serviço** (rolling update de ~2 min, sem build nem deploy de código). O corte instantâneo, sem reiniciar tasks, seria um perfil de feature flag no AppConfig (mesmo mecanismo das regras): não implementado. |
| **Observabilidade** | Gauge `circuit_breaker_state{channel}` (0/1/2) e `circuit_breaker_transitions_total` em `/metrics`; `deliveries_total{status=fallback\|deferred}`; no CloudWatch: `BreakerAntifraud/Push/Sms`, `DeliveriesFallback`, `DeliveriesDeferred` e dois widgets no dashboard. |

Limites assumidos: com o fallback ativo e o antifraude indisponível por muito tempo (> 10 min), os alertas vencem e vão à DLQ do canal, para reprocesso manual; a ordem por conta (grupo FIFO) é preservada, então uma mensagem adiada segura as seguintes do mesmo grupo até voltar.

## Gatilhos de revisão

Se o motor passar a bloquear transações (P-01 cai), o desenho muda para API síncrona com política *fail-closed* ou *fail-open* explícita e SLO bem mais baixo.
