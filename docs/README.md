# Motor de Detecção de Transações Suspeitas em Tempo Real — documentação

Resposta ao case **CE 1** (take-home de 7 dias, defesa ao vivo). Esta pasta guarda as decisões **antes do código**: o que assumimos, o que o sistema deve fazer, quão bem deve fazer e como os componentes conversam.

## Ordem de leitura

| # | Documento | Conteúdo | Status |
|---|-----------|----------|--------|
| 0 | [desafio-tecnico.md](desafio-tecnico.md) | Enunciado transcrito ([imagem original](assets/desafio-tecnico-original.jpg)) | pronto |
| 1 | [01-premissas.md](01-premissas.md) | Escopo, premissas `P-xx` de negócio, carga, segurança e plataforma; lista de ADRs em aberto | rascunho v0.1 |
| 2 | [02-requisitos-funcionais.md](02-requisitos-funcionais.md) | `RF-xx` por área, prioridade M/S/C e 11 cenários críticos de teste | rascunho v0.1 |
| 3 | [03-requisitos-nao-funcionais.md](03-requisitos-nao-funcionais.md) | `RNF-xx` mensuráveis, orçamento de latência e trade-offs | rascunho v0.1 |
| 4 | [contratos/](contratos/README.md) | Schemas JSON, OpenAPI, exemplos e validação | rascunho v0.1 |
| 5 | [adr/](adr/README.md) | ADR-01 a 05: mensageria, dedupe e estado de janela, motor de regras, armazenamento, degradação | proposto |
| 6 | [pesquisa-taxa-de-alertas.md](pesquisa-taxa-de-alertas.md) | Registro da pesquisa pública sobre taxa de fraude e de alerta (base do P-16) | pronto |
| 7 | [04-plano-implementacao.md](04-plano-implementacao.md) | Plano de 6 dias (07–12/10/2026), critérios de conclusão, cortes e roteiro da defesa | plano v0.1 |

## Escopo em fases (P-08)

| Fase | Entrega | Status |
|------|---------|--------|
| 1 | Pipeline completo com regras **stateless**: ingestão, idempotência, *outbox*, canais, resiliência, observabilidade, regras sem redeploy | obrigatória |
| 2 | Uma regra com janela (velocidade, `COUNT` por conta) atrás da porta `WindowStateStore` | *stretch* |
| — | Demais regras com janela e "viagem impossível" | só desenho |


1. Revisar os ADRs propostos em [adr/](adr/README.md) e decidir a linguagem de expressão das regras (CEL ou JSON Logic, ADR-03) com o teste do Dia 1. O adaptador Redis do estado de janelas (ADR-02) fica para a fase 2.
2. Resolver os pontos pendentes em [contratos/README.md](contratos/README.md#9-pontos-de-atenção-decisões-pendentes).
3. Desenho da arquitetura (C4 + fluxo de dados) em `docs/arquitetura/`.
4. Estrutura do código (hexagonal) e testes dos cenários críticos.

## Rastreabilidade

Premissas (`P-`) alimentam requisitos (`RF-`/`RNF-`), que viram contratos, ADRs e testes. Cada requisito aponta a origem no enunciado; cada premissa diz o que muda se ela cair.
