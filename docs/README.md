# Motor de Detecção de Transações Suspeitas em Tempo Real — documentação

Resposta ao case **CE 1** (take-home de 7 dias, defesa ao vivo). Esta pasta guarda as decisões tomadas antes e durante o código: o que assumimos, o que o sistema deve fazer, quão bem deve fazer e como os componentes conversam. Os documentos de planejamento (01 a 05) foram revisados em 12/10/2026 contra a implementação.

## Ordem de leitura

| # | Documento | Conteúdo | Status |
|---|-----------|----------|--------|
| 0 | [desafio-tecnico.md](desafio-tecnico.md) | Enunciado transcrito ([imagem original](assets/desafio-tecnico-original.jpg)) | pronto |
| 1 | [01-premissas.md](01-premissas.md) | Escopo, premissas `P-xx` de negócio, carga, segurança e plataforma; decisões que viraram os ADRs | vigente |
| 2 | [02-requisitos-funcionais.md](02-requisitos-funcionais.md) | `RF-xx` por área, prioridade M/S/C e 11 cenários críticos de teste | vigente |
| 3 | [03-requisitos-nao-funcionais.md](03-requisitos-nao-funcionais.md) | `RNF-xx` mensuráveis, orçamento de latência e trade-offs | vigente |
| 4 | [contratos/](contratos/README.md) | Schemas JSON, OpenAPI (só endpoints operacionais), exemplos e validação | vigente |
| 5 | [adr/](adr/README.md) | ADR-01 a 08: mensageria, dedupe e estado de janela, motor de regras, armazenamento, degradação, outbox com CDC, segurança, observabilidade | aceito (ADR-02 parcial) |
| 6 | [pesquisa-taxa-de-alertas.md](pesquisa-taxa-de-alertas.md) | Registro da pesquisa pública sobre taxa de fraude e de alerta (base do P-16) | pronto |
| 7 | [04-plano-implementacao.md](04-plano-implementacao.md) | Plano de 6 dias (07–12/10/2026), critérios de conclusão, cortes e roteiro da defesa | histórico (executado) |
| 8 | [fluxo-processamento.md](fluxo-processamento.md) | Fluxo implementado, da transação ao alerta entregue, com diagramas por etapa | pronto |
| 9 | [teste-de-carga-aws-1000tps.md](teste-de-carga-aws-1000tps.md) | Teste de carga k6 a 1.000 TPS na AWS: procedimento e critérios de avaliação | executado (11/10/2026) |
| 10 | [registro-testes-aws.md](registro-testes-aws.md) | Registro resumido dos testes (carga e simples) executados na AWS, com métricas | vivo |
| 11 | [modelo-de-dados.md](modelo-de-dados.md) | Diagrama entidade-relacionamento das tabelas do Postgres (alertas, outbox, entregas) | vivo |
| 12 | [degradacao-de-canais.md](degradacao-de-canais.md) | Circuit breaker, fallback push → SMS, adiamento e kill switch: diagramas e todos os cenários | pronto |
| 13 | [matriz-de-conformidade.md](matriz-de-conformidade.md) | Cada RF e RNF com situação (atendido, parcial, não atendido, não medido) e evidência | vivo |
| 14 | [teste-de-carga-aws-4000tps.md](teste-de-carga-aws-4000tps.md) | Resultado do teste de carga a 4.000 TPS na AWS: critérios, latência, recursos e comparação com 1.000 TPS | executado (13/10/2026) |
| 15 | [arquitetura-aws.md](arquitetura-aws.md) | Elementos da arquitetura na AWS (SQS, ECS, RDS, SNS, AppConfig e demais), com o desenho e os parâmetros dos perfis `lean` e `full` | pronto |

## Escopo em fases (P-08)

| Fase | Entrega | Status |
|------|---------|--------|
| 1 | Pipeline completo com regras **stateless**: ingestão, idempotência, *outbox*, canais, resiliência, observabilidade, regras sem redeploy | obrigatória |
| 2 | Uma regra com janela (velocidade, `COUNT` por conta) atrás da porta `WindowStateStore` | **não entregue** (cortada por prazo; desenho no [ADR-02](adr/ADR-02-dedupe-e-estado-de-janela.md)) |
| — | Demais regras com janela e "viagem impossível" | só desenho |


Próximos passos (o que ficou de fora e por quê) estão em [Limitações conhecidas e próximos passos](../README.md#limitações-conhecidas-e-próximos-passos), no README do repositório. Os que pedem decisão de documentação:

1. Testes de 8.000 TPS e da rajada de 25k: **não executados** (cotas de Fargate e do gerador k6). O degrau de 4.000 TPS foi medido e aprovado em 13/10/2026; ver o [registro](registro-testes-aws.md) (achados A9 a A11) e os ADR-01 e ADR-04.
2. Fechar as lacunas listadas nos [ADR-07](adr/ADR-07-seguranca-autenticacao-e-lgpd.md#lacunas-conhecidas) e [ADR-08](adr/ADR-08-observabilidade-e-slos.md#lacunas-conhecidas) que couberem no prazo. O alarme do SLO de latência e o do *outbox* já estão ativos; restam, por exemplo, o alarme de *circuit breaker* aberto e os *runbooks*.

## Rastreabilidade

Premissas (`P-`) alimentam requisitos (`RF-`/`RNF-`), que viram contratos, ADRs e testes. Cada requisito aponta a origem no enunciado; cada premissa diz o que muda se ela cair.
