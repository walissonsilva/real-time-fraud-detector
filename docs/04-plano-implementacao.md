# 04 — Plano de implementação em 6 dias

> Status: **plano v0.1** · Período: **07 a 12/10/2026**, inclusive, no fuso America/Sao_Paulo.
> Base: [premissas](01-premissas.md), [RF](02-requisitos-funcionais.md), [RNF](03-requisitos-nao-funcionais.md) e [contratos](contratos/README.md).

## Ponto de partida

Em 07/10, a pasta contém o enunciado, premissas, requisitos, cinco schemas JSON, OpenAPI, exemplos e um script de validação de contratos. Não há aplicação, manifesto de dependências, infraestrutura executável, testes do pipeline ou ADRs. O README já aponta para este plano, que ainda não existia. A pasta também não contém um repositório Git inicializado.

O cronograma assume **uma pessoa, seis dias corridos, com cerca de 6–8 horas úteis por dia**, incluindo o fim de semana. É uma hipótese de capacidade, não uma garantia. Este período atualiza o planejamento interno; a data da defesa e o prazo combinado com o avaliador precisam ser confirmados separadamente.

## Resultado esperado em 12/10

Uma entrega reproduzível via Docker Compose, com Node.js/TypeScript e NestJS nos adaptadores, domínio independente de framework e fluxo completo:

`evento → validação → regras stateless → decisão persistida + alerta + outbox → publicação → canais interno e externo`

A fase 1 de P-08 é obrigatória: idempotência durável, gestão de regras sem redeploy, resiliência, segurança demonstrável e observabilidade. O canal externo usa provedor simulado, com falhas controláveis. A regra de velocidade é opcional e só entra depois de estabilizar a fase 1.

As metas de **8.000 TPS, pico de 25.000 TPS e p99 ≤ 500 ms** permanecem critérios do desafio. O relatório deve separar resultados medidos, requisitos não atingidos e projeções de produção. Rodar localmente não comprova capacidade ou disponibilidade de uma implantação AWS.

## Cronograma e critérios de conclusão

| Dia | Foco | Entregas | Critério para encerrar o dia |
|-----|------|----------|-----------------------------|
| **1 — qua, 07/10** | Decisões e base executável | ADRs prioritários; C4 e fluxo de falhas; projeto TypeScript/NestJS; portas e adaptadores; Compose com broker e banco; migrações iniciais; CI básica; validação de contratos integrada | Ambiente sobe do zero; contratos e build passam; teste de integração publica e consome um evento e acessa o banco |
| **2 — qui, 08/10** | Detecção e consistência | Consumo e validação; regras stateless; registro de decisões; dedupe durável; alerta agregado; outbox e publicação; métricas de fila e latência | Evento normal não alerta; suspeito gera um alerta; duplicidade e concorrência geram um único registro; reinício entre commit e publicação recupera o outbox |
| **3 — sex, 09/10** | Regras em runtime e autorização | API de regras, versões imutáveis, revisão/aprovação, rollback, cache e atualização ≤ 30 s; rejeição de expressão perigosa e WINDOWED; JWT/RBAC; auditoria e kill switch de regra | Publicar e reverter muda a detecção sem reiniciar; autor não aprova a própria versão; repositório de regras fora mantém último snapshot válido; chamadas sem permissão falham |
| **4 — sáb, 10/10** | Entrega e recuperação | Canal antifraude e provedor externo simulado; dedupe de entrega; retry com jitter, circuit breaker, fallback e DLQ; kill switch de canal; backpressure e shutdown; dashboard e runbooks | Provedor fora não interrompe detecção; banco fora impede confirmação da entrada; recuperação drena pendências; evento inválido vai à DLQ e o fluxo continua |
| **5 — dom, 11/10** | Carga, falhas e ajustes | Gerador de eventos e scripts de carga; testes N e 2N workers; carga sustentada/pico; testes de falha automatizados; perfil de CPU/GC/event loop; relatório; configuração de segurança e arquitetura AWS | Cenários críticos da fase 1 executáveis; relatório registra throughput efetivo, p50/p95/p99, lag, drenagem e perdas/duplicidades; gargalos e desvios estão explícitos |
| **6 — seg, 12/10** | Fechamento e defesa | Correções finais; instalação limpa; README de execução; matriz RF/RNF; ADRs consolidados; limitações, dimensionamento e custo; apresentação e ensaio da demo | Outra execução do zero reproduz o fluxo, os testes e a demo; não há falha crítica aberta; entrega distingue implementado, simulado, documentado e não validado |

### Dia 1 — decisões que desbloqueiam o código

- **ADR-01:** escolher um único broker para a entrega local e definir o equivalente AWS. Comparar Kafka/MSK e SQS/SNS considerando throughput, ordenação por conta, timestamp do aceite, redelivery, DLQ e custo operacional. Não implementar dois adaptadores neste prazo.
- **ADR-02/04:** decidir dedupe e armazenamento de alertas, decisões, regras, auditoria e outbox. PostgreSQL é uma proposta inicial pela transação e pelas restrições de unicidade; confirmar no ADR. Estado de janela fica adiado.
- **ADR-03:** validar a linguagem de expressão com as expressões já existentes nos exemplos, inclusive `has(...)`. Os contratos usam string e apontam CEL como alvo; JSON Logic exigiria ajuste explícito de contrato. Não usar `eval`; limitar tamanho, profundidade, operadores e custo.
- **ADR-05:** definir comportamento por dependência: regras em cache; provedor isolado; banco indisponível sem ack; broker indisponível sem aceitar ingestão como concluída. Definir bootstrap sem snapshot de regras: não processar silenciosamente com conjunto vazio.
- Resolver inconsistências antes de congelar contratos: RF-04 usa `transactionId + eventType`, enquanto RNF-15 menciona apenas `transactionId`; separar dedupe de evento da unicidade de alerta. Verificar se a composição OpenAPI `RuleVersion` aceita metadados adicionais diante de `additionalProperties: false` no schema base.
- Definir como `publishedAt` será representado no outbox e na mensagem. O instante anterior ao envio e o aceite confirmado pelo broker são marcos diferentes; medir o SLO no aceite confirmado e documentar a semântica do payload.
- Estruturar domínio, casos de uso, portas (`EventBus`, `RuleRepository`, persistência transacional, `NotificationProvider`, `WindowStateStore`) e adaptadores. Criar testes de contrato para JSON e OpenAPI, sem confundir suporte estrutural a WINDOWED com habilitação na fase 1.

**Limite:** fechar decisões no primeiro bloco do dia. Se uma opção consumir o restante do dia em configuração, registrar o motivo e escolher a alternativa que permita executar o fluxo local.

### Dia 2 — invariantes antes de funcionalidades adicionais

- Validar `TransactionEvent v1`; registrar `ingestedAt` do broker e `consumedAt` do worker; propagar `traceparent`.
- Implementar regras de valor, país, MCC e horário quando os campos necessários existirem, com severidade máxima e agregação de score explicitamente definida. Fixar fuso da regra de horário e comportamento para campo ausente.
- Na mesma transação, registrar processamento/decisão e, quando houver disparo, alerta e outbox. Eventos sem alerta também precisam de conclusão durável antes do ack.
- Garantir dedupe de entrada por `transactionId + eventType` e unicidade de alerta por `transactionId`/`dedupeKey`, inclusive com consumidores concorrentes. Evento posterior de outro tipo é avaliado, mas não cria segundo alerta (P-07).
- Confirmar a entrada somente após commit. Publicar pendências do outbox e tratar falha entre envio e marcação: a publicação pode repetir; consumidores devem deduplicar por `alertId`.
- Instrumentar desde já latência de decisão de todos os eventos, latência de alerta incluindo fila, backlog do outbox e erros. Evitar identificadores de cliente em labels de métricas.

**Testes do dia:** cenários críticos 1, 2 e 3; sem disparo; eventos distintos da mesma transação; falha do banco; falha após envio antes de marcar outbox.

### Dia 3 — operação de regras sem redeploy

- Implementar o ciclo `DRAFT → IN_REVIEW → ACTIVE → ARCHIVED`, criação de novas versões, rollback e desativação. Separar status do ciclo de vida de `mode: ACTIVE/SHADOW`.
- Carregar um snapshot válido e trocar o conjunto de regras atomicamente; cada decisão registra a versão usada. Recarregar em até 30 s e manter o último snapshot em falha de atualização.
- Implementar validação sem execução arbitrária, bloqueio de WINDOWED na fase 1 e limites de custo. Shadow e simulação só entram se o fluxo obrigatório estiver completo.
- Validar JWT, assinatura, expiração, issuer/audience e escopos; identidades distintas para autor e aprovador. Registrar mudanças e acessos administrativos na auditoria sem endpoint de alteração do histórico.
- Integrar testes de autorização, rejeição de regras e atualização em runtime à CI.

**Testes do dia:** cenários 5, 6, 11 e 12; atualização concorrente; rollback; 401/403; tentativa de autoaprovação.

### Dia 4 — canais e falhas isoladas

- Rotear para uma fila antifraude e um canal externo simulado. Usar `deliveryId` estável por alerta/canal e `alertId` como chave enviada ao receptor.
- Separar filas e concorrência dos canais; persistir tentativas e resultados. Implementar timeouts, retry limitado com jitter, circuit breaker e fallback do canal externo para outro canal simulado.
- Produzir `DlqMessage v1` para entrada inválida e falha terminal de entrega; limitar ciclos de redrive. Disponibilizar comando operacional de reprocessamento idempotente da DLQ, sem ampliar para replay histórico.
- Implementar kill switch de canal, readiness de dependências críticas, graceful shutdown e consumo com concorrência limitada.
- Completar logs estruturados, tracing até entrega e dashboard de pipeline, regras e canais. Criar runbooks de lag, DLQ, provedor indisponível e regra ruim.

**Testes do dia:** cenários 8 e 10; banco indisponível (RF-43); morte do worker; fallback; redrive sem novo alerta; interrupção com mensagens em voo.

### Dia 5 — medir e corrigir com evidência

- Primeiro executar baseline curto e verificar o gerador; depois executar 8.000 TPS por 1 h e pico de 25.000 TPS por 15 min, quando a capacidade do ambiente permitir. Medir drenagem nos 5 min seguintes.
- A carga deve atravessar o broker e o banco reais do Compose. Usar produtor específico do broker; k6 serve para o caminho HTTP caso esse adaptador seja entregue. Medir entrada aceita, decisões concluídas e alertas publicados separadamente.
- Registrar hardware, versões, quantidade de workers/partições, regras ativas, tamanho dos eventos, percentual de alertas, duração e parâmetros. Medir espera na fila, latência do outbox, CPU, memória e event loop lag.
- Testar o cenário crítico 9, comparação N/2N e falhas de broker, banco, regras e provedor. Verificar contagem de eventos e unicidade após recuperação.
- Corrigir os gargalos observados com batches, concorrência limitada, índices e redução de I/O por evento; repetir apenas medições afetadas pelas mudanças.
- Verificar limites de payload, mascaramento de logs, segredos externos, imagem sem root e dependências. Demonstrar TLS/autenticação no ambiente de validação; documentar KMS, IAM, retenção, backup e multi-AZ no alvo AWS, declarando o que não foi implantado.

**Relatório:** cada meta recebe resultado **atingido / não atingido / não validado**. Não substituir teste ponta a ponta por benchmark do motor de regras. Disponibilidade mensal, retenção de cinco anos e operação multi-AZ não são comprováveis por uma execução local de seis dias.

### Dia 6 — congelar e tornar a entrega defensável

- Não iniciar funcionalidades novas. Reservar o dia para correções, execução limpa e material da defesa.
- Executar build, contratos, testes unitários/integração e cenários críticos; exigir ≥ 80% de cobertura do domínio e evidências para todos os cenários da fase 1, incluindo falhas e desvios de carga.
- Documentar comandos de instalação, configuração sem segredos, subida, migrations/seed, testes, carga, demo e limpeza. Conferir todos os links e arquivos citados.
- Criar matriz RF/RNF com evidência e status; explicar as diferenças entre Compose e produção AWS. Incluir arquitetura de retenção, recuperação, rollout e estimativa de custo com hipóteses e fontes verificadas no momento da elaboração.
- Preparar apresentação breve e ensaiar a defesa: problema, decisões, demo, resultados, falhas, trade-offs e evolução.

## Cortes e contingência

| Condição | Ação |
|----------|------|
| Fluxo durável não passa os testes ao fim do dia 2 | Remover toda funcionalidade S/C do caminho imediato; usar o início do dia 3 para corrigir consistência |
| Regras em runtime não estão estáveis ao fim do dia 3 | Adiar shadow, simulação, consultas avançadas e política dinâmica; preservar publicação, aprovação, rollback e cache |
| Canais e recuperação não estão completos ao fim do dia 4 | Descartar fase 2; priorizar retries, isolamento, DLQ e testes no dia 5 |
| Ambiente não sustenta a carga-alvo | Medir capacidade real, identificar gargalo e registrar a meta pendente; não alegar cumprimento por extrapolação |
| Fase 1 completa antes do dia 5, com testes passando e tempo de carga reservado | Considerar apenas velocidade COUNT por accountId; exigir dedupe antes de atualizar janela, lateness de 5 min e testes 4 e 7. Se não houver tempo, manter apenas a porta |

Ordem de corte dos opcionais: deploy de validação AWS → regra de velocidade → shadow/simulação → listas/fadiga/política dinâmica → ingestão HTTP e API de consulta/status. Nenhum corte altera silenciosamente a prioridade original: registrar os S não entregues na matriz. Se faltar tempo para um M, declarar o requisito incompleto e seu impacto.

Não cortar unicidade durável, outbox, regras sem redeploy, aprovação separada, canais interno/externo, isolamento de falhas, segurança básica, métricas ou testes críticos. ML, UI, viagem impossível, demais agregações e replay histórico ficam fora da implementação. Roteamento mínimo é configuração externa; a API completa de política dinâmica é opcional.

## Roteiro mínimo da demo

1. Subir o ambiente e mostrar readiness, regras e métricas.
2. Processar transação normal e suspeita; mostrar alerta e entregas interna/externa.
3. Reenviar e processar concorrentemente o evento; comprovar um alerta persistido.
4. Publicar regra com outra identidade; mostrar atualização em até 30 s e rollback.
5. Derrubar o provedor; mostrar detecção contínua, retry/fallback/DLQ e recuperação.
6. Interromper publicação do outbox ou o banco; mostrar retomada sem perda de resultado confirmado.
7. Mostrar relatório de carga, limitações e próximo passo de produção.

## Definição de entrega concluída

- Fase 1 executável e reproduzível, com contratos respeitados e todos os requisitos M rastreados.
- Cenários críticos **1, 2, 3, 5, 6, 8, 9, 10, 11 e 12** automatizados ou, no caso de carga limitada pelo ambiente, executados com o desvio e a evidência registrados. Cenários 4 e 7 somente se a fase 2 for entregue.
- Resultados de carga e recuperação publicados, inclusive metas não atingidas; latência inclui espera na fila e publicação do outbox.
- README, arquitetura, ADRs, segurança, runbooks, matriz e apresentação coerentes com o código efetivamente entregue.
- Componentes simulados e controles de produção apenas documentados identificados explicitamente.
