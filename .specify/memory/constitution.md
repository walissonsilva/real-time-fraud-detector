<!--
Sync Impact Report
- Version change: 1.0.0 → 2.0.0
- Princípios modificados: I (Arquitetura Hexagonal → Arquitetura Modular NestJS); VI (referência à porta `RuleEngine` → serviço `DeclarativeRuleEngine`)
- Seções adicionadas: Princípios I–VII, Restrições Técnicas e de Segurança,
  Fluxo de Desenvolvimento e Portões de Qualidade, Governança
- Seções removidas: nenhuma
- Templates:
  - ✅ .specify/templates/plan-template.md (Constitution Check já referencia este arquivo; sem mudança)
  - ✅ .specify/templates/spec-template.md (sem mudança necessária)
  - ✅ .specify/templates/tasks-template.md (sem mudança necessária)
  - ✅ AGENTS.md (regras de commit e leitura de docs/ permanecem consistentes)
- TODOs adiados: nenhum
-->
# Real-Time Fraud Detector Constitution

## Core Principles

### I. Arquitetura Modular NestJS
O código MUST seguir a organização padrão do NestJS: um módulo por funcionalidade
(`transactions`, `rules`, `alerts`, `deliveries`, `dlq`, `health`) mais módulos transversais
(`config`, `observability`, `database`, `aws`, `cache`). Serviços e repositórios são
`@Injectable()` e injetados pela classe; módulos declaram `providers`/`exports`/`imports`
explicitamente, sem dependências circulares. Regras de negócio puras (decisão, dedupe, validação)
SHOULD ser funções sem I/O, testáveis sem Nest. Abstrações (interfaces + token) só são
justificadas quando houver mais de uma implementação real.
Racional: estrutura familiar à equipe, menos indireção e testabilidade preservada.

### II. Contratos Primeiro (NON-NEGOTIABLE)
Eventos, alertas, regras, mensagens de DLQ e a API HTTP MUST ser definidos como contratos
versionados em `docs/contratos/` (JSON Schema / OpenAPI) antes da implementação. Mudanças
incompatíveis MUST criar uma nova versão do contrato (`v2`), nunca alterar a `v1` publicada.
`npm run contracts:validate` MUST passar antes de qualquer merge que toque contratos ou
produtores/consumidores deles.
Racional: serviços internos produzem e consomem estes dados de forma independente.

### III. Idempotência e Consistência de Alertas
O processamento MUST ser seguro sob entrega repetida (at-least-once): a mesma transação MUST
NOT gerar alertas duplicados para a mesma regra, mesmo com retentativas, reentregas ou
consumidores concorrentes. A deduplicação MUST ser garantida por chave determinística e
restrição atômica no armazenamento, não apenas por verificação em memória.
Racional: o desafio exige explicitamente “sem alertas duplicados”.

### IV. Resiliência e Degradação Controlada
A queda de um serviço auxiliar (cache, notificação, banco secundário) MUST NOT interromper a
detecção. Toda chamada externa MUST ter timeout, política de retentativa com backoff e
estratégia de degradação definida. Mensagens que falham definitivamente MUST ir para uma DLQ
conforme o contrato, sem perda silenciosa. Falhas e a estratégia de recuperação MUST ser
cobertas por testes.
Racional: o motor precisa seguir operando com dependências parciais.

### V. Desempenho com Orçamento Explícito
O sistema MUST mirar 8.000 TPS sustentados (picos de 25 mil) e latência de alerta ≤ 500 ms. O
caminho crítico de detecção MUST evitar I/O síncrono desnecessário e trabalho não limitado;
estado de janelas MUST usar estruturas adequadas (ex.: Redis com operações atômicas). Mudanças
no caminho crítico MUST declarar o impacto esperado na latência e na vazão e ser verificadas por
teste de carga ou benchmark proporcional à mudança.
Racional: escala e latência são os requisitos que mais restringem as decisões de arquitetura.

### VI. Regras Extensíveis sem Redeploy
Regras de detecção MUST ser dados versionados (contrato `rule`/`rule-version`), criados e
alterados em tempo de execução via API, com histórico de versões. Adicionar ou ajustar uma regra
MUST NOT exigir novo deploy. O motor MUST avaliar regras por meio do serviço `DeclarativeRuleEngine` (módulo `rules`), sem
lógica de regra específica no código dos adaptadores.
Racional: o desafio exige extensibilidade sem redeploy.

### VII. Segurança, Privacidade e Observabilidade
Dados MUST ser cifrados em trânsito e em repouso; a comunicação entre serviços MUST ser
autenticada. Dados pessoais MUST seguir a LGPD: coletar o mínimo necessário, mascarar/omitir
dados sensíveis em logs e nunca registrar segredos. Segredos MUST vir de configuração
externa, nunca do repositório. O sistema MUST emitir logs estruturados, métricas e health
checks (liveness/readiness) suficientes para operação SRE e resposta a incidentes.
Racional: segurança ponta a ponta e monitoramento operacional são exigências do desafio.

## Restrições Técnicas e de Segurança

- Stack: Node.js ≥ 22, TypeScript, NestJS; Postgres (persistência), Redis (estado de janelas e
  cache), SQS/SNS (mensageria, emulados com LocalStack localmente).
- Qualquer nova tecnologia ou dependência relevante MUST ser justificada (o desafio exige
  justificativa das escolhas) e registrada como decisão arquitetural.
- Mudanças de esquema do banco MUST ser feitas por migrações versionadas e reproduzíveis.
- A infraestrutura local MUST subir com `npm run infra:up` e ser descartável com
  `npm run infra:down`.
- O repositório MUST NOT conter segredos reais; `.env.example` documenta a configuração.

## Fluxo de Desenvolvimento e Portões de Qualidade

- Testes: lógica de domínio e casos de uso MUST ter testes unitários; fluxos que cruzam
  adaptadores (banco, cache, mensageria) MUST ter testes de integração/e2e. Cenários críticos
  (duplicidade, falha de dependência, DLQ, limites de janela) MUST ter cobertura explícita.
  Para comportamento novo, os testes SHOULD ser escritos antes da implementação.
- Portões antes de concluir qualquer mudança: `npm run lint`, `npm test` e, quando aplicável,
  `npm run test:int`, `npm run test:e2e` e `npm run contracts:validate` MUST passar.
- Simplicidade: prefira a solução mais simples que atenda aos requisitos; complexidade
  adicional MUST ser justificada na seção Complexity Tracking do plano.
- Git: nenhuma mudança é commitada ou enviada por push sem pedido explícito do usuário; após
  modificar arquivos, pare e aguarde revisão (ver `AGENTS.md`).
- Spec Kit: os fluxos `/speckit-*` MUST respeitar a lista de arquivos de `docs/` vetados em
  `AGENTS.md`.

## Governance

Esta constituição prevalece sobre outras práticas do projeto. Todo plano (Constitution Check) e
toda revisão MUST verificar conformidade com os princípios; desvios MUST ser justificados por
escrito no plano.

**Emendas**: propostas via `/speckit-constitution` ou alteração direta deste arquivo, com
descrição da mudança, racional e atualização dos templates/artefatos dependentes. Mudanças que
alterem princípios exigem aprovação explícita do usuário.

**Versionamento (SemVer)**: MAJOR para remoção ou redefinição incompatível de princípios ou
governança; MINOR para novo princípio/seção ou expansão material; PATCH para esclarecimentos e
correções de redação.

**Revisão de conformidade**: verificada no Constitution Check de cada plano e na revisão de
cada mudança. Orientações de execução para agentes ficam em `AGENTS.md`.

**Version**: 2.0.0 | **Ratified**: 2026-10-08 | **Last Amended**: 2026-10-08
