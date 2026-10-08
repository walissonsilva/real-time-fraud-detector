# ADR-02 — Deduplicação e estado de janela

> Status: **proposto** · Data: 07/10/2026 · Premissas: P-04, P-17 a P-19 · Requisitos: RF-04, RF-12, RF-18, RF-31, RF-41, RNF-14, RNF-15, RNF-16

## Contexto

Há duas necessidades distintas. Primeiro, **no máximo um alerta por `transactionId`**, mesmo com reentrega, *retry* ou reprocessamento. Segundo, na fase 2, **estado de janela** para a regra de velocidade (`COUNT` por `accountId`), com uma atualização por evento em 8.000 a 25.000 operações por segundo.

## Decisão

1. **Unicidade do alerta:** `UNIQUE (dedupe_key)` no Postgres, com `dedupe_key = sha256("fraud-alert:v1:" + transactionId)` e insert com `ON CONFLICT DO NOTHING` (ADR-04). É a garantia, sem janela de tempo. O cache não substitui a restrição.
2. **Deduplicação do evento de entrada (RF-04):** sem armazenamento próprio. Reavaliar um duplicado produz a mesma decisão, e o conflito acontece na gravação do alerta. Um cache em memória ou Redis com TTL entra só como otimização, se o teste de carga mostrar necessidade.
3. **Estado de janela (fase 2):** Redis, com um `ZSET` por chave de agrupamento (`win:{ruleId}:{accountId}`), membro = `transactionId` e score = `occurredAt` em ms. Registrar e contar acontecem numa operação atômica (script Lua): `ZADD`, poda por `ZREMRANGEBYSCORE` fora de `occurredAt − janela − tolerância`, `ZCOUNT` em `[occurredAt − janela, occurredAt]` e `EXPIRE` com o TTL da regra. É idempotente por construção: o mesmo membro não conta duas vezes numa reentrega.
4. **Eventos atrasados (P-19):** entram no lugar certo pelo score, até 5 minutos. Acima disso, o alerta sai com `late=true`.
5. **Porta `WindowStateStore`:** `recordAndCount(chave, eventId, occurredAt, janela)`, definida **já na fase 1**, com implementação em memória (testes e cenário 4). O adaptador Redis só entra na fase 2, atrás de um *gate*. O Redis já fica no `docker-compose`.
6. **Ordenação:** não é exigida. A contagem é comutativa, e cada evento decide pelo valor que a própria gravação devolve, então o último evento processado vê a contagem completa mesmo fora de ordem.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Contadores por *bucket* com `INCR` e chave `SET NX` por evento | Mais barato em memória, mas dobra as escritas e dá janela aproximada |
| DynamoDB como estado de janela | 25k escritas/s com custo alto e risco de partição quente |
| Estado local no *worker* com *changelog* | Exige partição e ordem por conta e tratamento de *rebalance* |

## Consequências

- O Redis é uma dependência nova **só na fase 2**. Se cair, regras stateless seguem e as de janela entram em modo degradado (ADR-05); o estado se reconstrói sozinho em alguns minutos.
- Memória: da ordem de poucos milhões de membros na janela, a estimar no teste de carga.
- Contas com tráfego muito concentrado viram chave quente.
- A fase 1 já entrega a porta e a implementação em memória, o que reduz o custo da fase 2.

## Gatilhos de revisão

Memória do Redis acima do esperado, necessidade de regras que dependam de sequência (como "viagem impossível", hoje fora do escopo) ou janelas muito longas.
