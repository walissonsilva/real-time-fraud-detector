# 02 — Requisitos funcionais

> Status: **rascunho v0.1** · Premissas: [01-premissas.md](01-premissas.md) · Contratos: [contratos/](contratos/README.md)
> Prioridade: **M** = Must (núcleo do desafio) · **S** = Should (entrega se houver tempo) · **C** = Could (documentado, não implementado).
> A coluna "Origem" liga cada requisito ao enunciado.
> **Fases (P-08):** a **fase 1** cobre as regras *stateless*; a **fase 2** (*stretch*) acrescenta a regra de velocidade. Requisitos que só existem por causa de regras com janela estão marcados "fase 2".

## RF-1 Ingestão

| ID | Requisito | Prio | Origem |
|----|-----------|------|--------|
| RF-01 | Consumir eventos `TransactionEvent v1` do barramento de eventos. | M | "Receber eventos de transações em tempo real" |
| RF-02 | Validar cada evento contra o schema; eventos inválidos vão para DLQ com o motivo, sem interromper o fluxo. | M | Resiliência |
| RF-03 | Oferecer endpoint HTTP opcional `POST /v1/transactions` (resposta `202`) como adaptador para produtores sem acesso ao barramento. | S | P-02 |
| RF-04 | Descartar de forma idempotente eventos duplicados (mesmo `transactionId` + `eventType`, ver P-03). | M | "sem alertas duplicados" |
| RF-05 | Registrar `ingestedAt` = instante em que o **barramento aceitou o evento** (timestamp do broker: `SentTimestamp` no SQS, *LogAppendTime* no Kafka; no adaptador HTTP, o recebimento na API) e `consumedAt` = início do processamento pelo motor. `consumedAt − ingestedAt` é o tempo de fila. O relógio do produtor não é usado. | M | "alerta ≤ 500 ms" |

## RF-2 Detecção

| ID | Requisito | Prio | Origem |
|----|-----------|------|--------|
| RF-10 | Avaliar cada evento contra o conjunto de regras **ativas** e gerar uma decisão (`score`, `severity`, regras disparadas). | M | "Aplicar lógica de detecção" |
| RF-11 | Suportar regras **stateless** (só o evento): valor acima do limite, país de risco, MCC de risco, horário atípico. | M | |
| RF-12 | Suportar regras **com janela** (agregação por cliente/conta). **Fase 2: apenas velocidade** (N transações em T minutos, `COUNT` por `accountId`). Soma de valores em T, *burst* de recusas, múltiplos dispositivos/países e "viagem impossível" (distância/tempo) ficam **documentados, não implementados**. | S (fase 2) | |
| RF-13 | Suportar **listas** de apoio (deny list/allow list de contrapartes, dispositivos e merchants) como entrada das regras. | S | |
| RF-14 | Avaliar regras por **perfil comportamental simples** (desvio do valor típico do cliente). | C | |
| RF-15 | Expor ponto de extensão para um **scorer externo** (ex.: modelo de ML) com *timeout* curto e fallback para as regras. | C | |
| RF-16 | O resultado agrega todas as regras disparadas; `severity` = maior severidade entre elas; `score` = função de agregação configurável. | M | P-04 |
| RF-17 | Transações sem nenhuma regra disparada **não** geram alerta, mas geram métrica e (amostrado) log de decisão. | M | |
| RF-18 | O domínio define a porta `WindowStateStore` (ler/atualizar agregado por chave e janela). Na fase 1 não há implementação: regras `WINDOWED` são **rejeitadas na validação** (RF-26) com erro claro até a fase 2 ser ativada. | M | Extensibilidade |

## RF-3 Gestão de regras sem redeploy

| ID | Requisito | Prio | Origem |
|----|-----------|------|--------|
| RF-20 | Regras são **dados** (definição declarativa), não código. API para criar, listar, consultar, editar e arquivar. | M | "Extensibilidade das regras sem redeploy" |
| RF-21 | Toda alteração gera uma **nova versão imutável**; só a versão publicada é avaliada. | M | |
| RF-22 | Ciclo de vida: `DRAFT → IN_REVIEW → ACTIVE → ARCHIVED`; reversão (*rollback*) para versão anterior com um comando. | M | |
| RF-23 | Instâncias do motor **recarregam regras em tempo de execução** sem reinício, em até 30 s após a publicação; mantêm a última versão válida se o repositório de regras estiver indisponível. | M | "Seguir operando se um serviço auxiliar cair" |
| RF-24 | Modo **shadow**: regra avaliada e registrada, mas sem gerar alerta, para calibrar antes de ativar. | S | |
| RF-25 | **Simulação (dry-run)**: avaliar uma regra candidata contra um evento ou lote de amostra e ver o resultado. | S | |
| RF-26 | Validar sintaxe e custo (limite de profundidade/tempo) da expressão antes de aceitar a regra, para impedir regra maliciosa ou lenta. | M | Segurança, latência |
| RF-27 | Rollout gradual por percentual de tráfego. | C | |

## RF-4 Alertas

| ID | Requisito | Prio | Origem |
|----|-----------|------|--------|
| RF-30 | Gerar `FraudAlert v1` com identificador único, regras disparadas, resumo mascarado da transação, severidade e *timestamps*. | M | "Gerar alertas" |
| RF-31 | Garantir **no máximo um alerta por `transactionId`** (idempotência), mesmo com reentrega, *retry* ou reprocessamento. | M | "Consistência e idempotência" |
| RF-32 | Persistir o alerta e publicá-lo atomicamente (*transactional outbox*): nunca há alerta publicado sem registro, nem registro sem publicação. | M | Consistência |
| RF-33 | Rotear alertas por **política de canais** configurável (por severidade/tipo de regra), também sem redeploy. | S | |
| RF-34 | Canal **interno**: enviar à fila/webhook da equipe antifraude. | M | "canais internos" |
| RF-35 | Canal **externo**: acionar o cliente (push/SMS/e-mail) através de adaptador de provedor. O provedor real pode ser simulado. | M | "canais ... externos" |
| RF-36 | Entrega por canal com **retry exponencial com *jitter***, *circuit breaker* por provedor, DLQ e *fallback* de canal (ex.: push → SMS). | M | Resiliência |
| RF-37 | Controle de **fadiga**: no máximo 1 notificação ao mesmo cliente por janela configurável (ex.: 5 min), agregando alertas. | S | |
| RF-38 | API de consulta e atualização de status do alerta (`OPEN`, `ACK`, `CONFIRMED_FRAUD`, `FALSE_POSITIVE`). | S | |
| RF-39 | Consumidores recebem o `alertId` como chave de idempotência em todos os canais. | M | |

## RF-5 Degradação e recuperação

| ID | Requisito | Prio | Origem |
|----|-----------|------|--------|
| RF-40 | Indisponibilidade do **repositório de regras**: continua com a última versão em cache. | M | "Seguir operando" |
| RF-41 | Indisponibilidade do **estado de janelas** (cache/Redis): regras stateless continuam; regras com janela entram em modo degradado e o alerta é marcado `degraded=true`. | S (fase 2) | |
| RF-42 | Indisponibilidade do **provedor externo**: alertas ficam na fila de entrega, com *retry* e DLQ, sem perder alerta e sem afetar a detecção. | M | |
| RF-43 | Indisponibilidade do **banco de alertas**: o evento não é confirmado (*ack*) no broker e volta para a fila (*backpressure*); nenhum evento é descartado. | M | |
| RF-44 | **Reprocessamento** de DLQ e de intervalo de tempo, com idempotência garantida (não duplica alertas). | S | |
| RF-45 | *Graceful shutdown*: terminar mensagens em voo antes de encerrar o processo. | M | |

## RF-6 Operação

| ID | Requisito | Prio | Origem |
|----|-----------|------|--------|
| RF-50 | Endpoints de saúde: `/health/live` e `/health/ready` (ready falha se a dependência crítica estiver fora). | M | "Monitoramento operacional" |
| RF-51 | Métricas, *logs* estruturados e *traces* correlacionados por `traceId` (detalhes em [03](03-requisitos-nao-funcionais.md)). | M | |
| RF-52 | *Runbooks* para os incidentes mais prováveis (lag crescente, DLQ crescendo, provedor fora, regra ruim publicada). | M | "resposta a incidentes" |
| RF-53 | *Kill switch*: desativar uma regra ou um canal imediatamente, sem deploy. | M | |

## Cenários críticos (base da estratégia de testes)

Os cenários 4 e 7 só valem na fase 2; os demais são da fase 1. Acrescenta-se: **12.** regra `WINDOWED` enviada na fase 1 → rejeitada na validação com erro claro.


1. Evento duplicado entregue duas vezes → um único alerta.
2. Dois consumidores processam o mesmo evento simultaneamente (*race*) → um único alerta.
3. Falha após persistir o alerta e antes de publicar → o *outbox* publica depois; sem duplicidade.
4. *(fase 2)* Evento fora de ordem dentro do limite de atraso → regra com janela avalia corretamente.
5. Regra nova publicada → vale em até 30 s sem reinício; *rollback* restaura o comportamento anterior.
6. Repositório de regras fora → continua com o cache.
7. *(fase 2)* Estado de janelas fora → regras stateless seguem; alertas marcados `degraded`.
8. Provedor externo fora → *retry*, *circuit breaker*, *fallback* e DLQ; detecção intocada.
9. Rajada de 25k TPS → fila absorve, latência dentro do SLO ou *lag* controlado e alarme.
10. Evento malformado → DLQ; o fluxo segue.
11. Regra maliciosa/lenta → rejeitada na validação.
