# ADR-02 — Deduplicação e estado de janela

> Status: **aceito** para a unicidade do alerta (implementado) · **decidido, não implementado** para o estado de janela (adiado por prazo) · Data: 07/10/2026 (revisado em 12/10/2026) · Premissas: P-04, P-17 a P-19 · Requisitos: RF-04, RF-12, RF-18, RF-31, RF-41, RNF-14, RNF-15, RNF-16

## Contexto

Há duas necessidades distintas. Primeiro, **no máximo um alerta por `transactionId`**, mesmo com reentrega, *retry* ou reprocessamento. Segundo, na fase 2, **estado de janela** para a regra de velocidade (`COUNT` por `accountId`), com uma atualização por evento em 8.000 a 25.000 operações por segundo.

## Estado atual (12/10/2026)

| Parte | Situação |
|-------|----------|
| Unicidade do alerta no Postgres (decisões 1 e 2) | **Implementada** e coberta por testes (`determinism.spec`, `no-silent-loss.int-spec`) e pela carga a 1.000 TPS, com 0 duplicados |
| Estado de janela no Redis (decisões 3 a 6) | **Não implementada**. A regra de velocidade foi cortada por prazo; o motor só aceita regras `STATELESS` e recusa, na partida, um documento com regra de janela |
| Infraestrutura do Redis | **Provisionada** (ElastiCache com TLS, `auth_token` e KMS) e conectada ao app (`RedisModule`), mas **nenhum código de negócio o utiliza**. Só o `/health/ready` faz `PING`, de forma informativa |
| Porta `WindowStateStore` | **Não existe** no código. O texto original previa defini-la na fase 1; isso não foi feito |

O Redis ficou provisionado de propósito: remover recursos do Terraform perto do teste de 8.000 TPS invalidaria a linha de base já medida e traria risco sem ganho para o resultado. Sem a regra de janela, ele é custo e superfície de ataque sem uso, registrados como dívida conhecida.

## Decisão

1. **Unicidade do alerta** *(implementada)*: `UNIQUE (dedupe_key)` no Postgres, com `dedupe_key = sha256("fraud-alert:v1:" + transactionId)` e insert com `ON CONFLICT DO NOTHING` (ADR-04). É a garantia, sem janela de tempo. O cache não substitui a restrição.
2. **Deduplicação do evento de entrada (RF-04)** *(implementada)*: sem armazenamento próprio. Reavaliar um duplicado produz a mesma decisão, e o conflito acontece na gravação do alerta. Um cache em memória ou Redis com TTL só entraria como otimização, se o teste de carga mostrasse necessidade (não mostrou a 1.000 TPS).
3. **Estado de janela** *(adiado)*: Redis, com um `ZSET` por chave de agrupamento (`win:{ruleId}:{accountId}`), membro = `transactionId` e score = `occurredAt` em ms. Registrar e contar acontecem numa operação atômica (script Lua): `ZADD`, poda por `ZREMRANGEBYSCORE` fora de `occurredAt − janela − tolerância`, `ZCOUNT` em `[occurredAt − janela, occurredAt]` e `EXPIRE` com o TTL da regra. É idempotente por construção: o mesmo membro não conta duas vezes numa reentrega.
4. **Eventos atrasados (P-19)** *(adiado)*: entram no lugar certo pelo score, até 5 minutos. Acima disso, o alerta sai com `late=true`.
5. **Porta `WindowStateStore`** *(adiado)*: `recordAndCount(chave, eventId, occurredAt, janela)`, com implementação em memória para testes e adaptador Redis em produção.
6. **Ordenação** *(adiado)*: não é exigida. A contagem é comutativa, e cada evento decide pelo valor que a própria gravação devolve, então o último evento processado vê a contagem completa mesmo fora de ordem.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Contadores por *bucket* com `INCR` e chave `SET NX` por evento | Mais barato em memória, mas dobra as escritas e dá janela aproximada |
| DynamoDB como estado de janela | 25k escritas/s com custo alto e risco de partição quente |
| Estado local no *worker* com *changelog* | Exige partição e ordem por conta e tratamento de *rebalance* |
| Remover o Redis agora | Reduz custo e superfície, mas muda a infraestrutura às vésperas do teste de 8.000 TPS e joga fora a base já validada. Fica para depois da defesa, caso a fase 2 não avance |

## Consequências

- Hoje o produto detecta **só por regras sem estado**: valor alto, contraparte nova com valor alto, país/MCC de risco e combinação incomum de canal e tipo. Padrões de repetição (muitas transações em pouco tempo por conta) **não são detectados**; é a principal lacuna funcional frente ao caso de uso.
- O Redis **não afeta a disponibilidade**: o `/health/ready` só falha por Postgres, e o healthcheck do ECS usa `/health/live`. Uma queda do Redis não derruba nem retira o serviço do tráfego.
- Quando a fase 2 for implementada, o Redis fora faz as regras de janela entrarem em modo degradado (ADR-05) e o estado se reconstrói sozinho em alguns minutos.
- Memória: da ordem de poucos milhões de membros na janela, a estimar no teste de carga da fase 2.
- Contas com tráfego muito concentrado viram chave quente.

## Gatilhos de revisão

Decisão de implementar a regra de velocidade (reativa as decisões 3 a 6 e este ADR passa a "aceito" por inteiro), decisão de desligar o Redis (remover o `RedisModule` e o recurso no Terraform), memória do Redis acima do esperado, necessidade de regras que dependam de sequência (como "viagem impossível", hoje fora do escopo) ou janelas muito longas.
