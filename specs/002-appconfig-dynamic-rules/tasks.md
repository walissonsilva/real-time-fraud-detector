---

description: "Task list — Regras de Decisão Dinâmicas via AppConfig"
---

# Tasks: Regras de Decisão Dinâmicas via AppConfig

**Input**: Design documents from `/specs/002-appconfig-dynamic-rules/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/appconfig-rules-source.md, contracts/rules-document.v1.schema.json, contracts/rules-document.v1.draft4.schema.json, quickstart.md

**Tests**: Incluídos. A constituição exige testes para lógica de domínio e para cenários críticos de falha de dependência, e recomenda escrevê-los antes da implementação. Em cada story, as tarefas de teste vêm primeiro e devem falhar antes da implementação.

**Organization**: Tarefas agrupadas por user story. US1, US2 e US3 são P1 (US1 é o MVP); US4 e US5 são P2; US6 é P3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivos diferentes, sem dependência de tarefa incompleta)
- **[Story]**: US1 a US6
- Caminhos relativos à raiz do repositório (`/home/wali/dev/real-time-fraud-detector`)

## Contexto de código existente (não recriar)

- `src/rules/`: `DeclarativeRuleEngine` (classe pura; `validate(rule)` e `evaluate(rules, tx)`), `loadRulesConfig(path, engine)` em `rules-config.loader.ts` (lê o arquivo, valida contrato e engine, congela o resultado), `StaticRuleRepository` (`loadActiveSnapshot()`, `currentRevision()`), `RuleSnapshot { revision, rules }`, `RulesModule` (fábrica síncrona que lê `config.rulesConfigPath`).
- `src/transactions/process-transaction.service.ts` injeta `StaticRuleRepository` pela classe e chama `loadActiveSnapshot()` uma vez por evento (linha ~72). Testes existentes constroem `new StaticRuleRepository(snapshot)` (`process-transaction.service.spec.ts`, `determinism.spec.ts`, `test/integration/*`).
- `src/config/config.module.ts` (`AppConfig`, `loadConfig`, `APP_CONFIG`), `src/aws/aws-clients.module.ts` (tokens `SQS_CLIENT`, `SNS_CLIENT`), `src/observability/` (`JsonLogger` com redação, `InMemoryMetrics` com `increment`, `gauge`, `observe`, `render`), `src/health/metrics.controller.ts` (`/metrics` em texto).
- Contratos em `docs/contratos/` validados por `docs/contratos/validate-contracts.mjs` (`npm run contracts:validate`); o `Dockerfile` já copia `docs/contratos` e `config` para a imagem.
- Jest unitário: `rootDir: src`, `*.spec.ts`. Integração: `test/integration/*.int-spec.ts` (`npm run test:int`, exige `npm run infra:up`).
- Terraform em `infra/terraform/envs/production/` (`iam.tf` com `aws_iam_role.app`, `ecs.tf` com `local.app_environment`, `monitoring.tf` com o tópico `ops` e os alarmes, `network.tf` com `local.interface_endpoints`, `outputs.tf`, `variables.tf`). O README de operação é `infra/terraform/README.md`.
- Abstrações só entram quando há duas implementações reais (constituição I): aqui `RuleRepository` terá `StaticRuleRepository` e `AppConfigRuleRepository`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependências, configuração e contratos (contratos primeiro, constituição II)

- [ ] T001 Em `package.json`, adicionar `@aws-sdk/client-appconfigdata` em dependencies (mesma faixa de versão de `@aws-sdk/client-sqs`) e `ajv-draft-04` em devDependencies (só para o teste de equivalência dos schemas); rodar `npm install` para atualizar `package-lock.json`
- [ ] T002 [P] Acrescentar a `.env.example` as variáveis `RULES_SOURCE=file`, `APPCONFIG_APPLICATION`, `APPCONFIG_ENVIRONMENT`, `APPCONFIG_PROFILE`, `RULES_POLL_INTERVAL_MS=20000`, `RULES_STARTUP_TIMEOUT_MS=45000` e `RULES_METRICS_EMF=false`, com comentários curtos (valores de AppConfig ficam vazios; o ambiente local usa `file`), conforme `contracts/appconfig-rules-source.md` §4
- [ ] T003 [P] Criar `docs/contratos/rules-document.v1.schema.json` (cópia de `specs/002-appconfig-dynamic-rules/contracts/rules-document.v1.schema.json`) e `docs/contratos/rules-document.v1.draft4.schema.json` (cópia do espelho draft 4), mais os exemplos em `docs/contratos/examples/`: `rules-document.stateless.valid.json` (as 4 regras de `config/rules.json`), `rules-document.empty-rules.invalid.json`, `rules-document.bad-rule-id.invalid.json`, `rules-document.missing-expression.invalid.json` e `rules-document.windowed-without-window.invalid.json`
- [ ] T004 Atualizar `docs/contratos/validate-contracts.mjs`: registrar o schema `rules-document` (adicionar o `rule.v1` ao Ajv por `$id` antes de compilar, para resolver o `$ref`), compilar o espelho draft 4 com `ajv-draft-04` e, para cada `examples/rules-document.*`, exigir que os **dois** validadores deem o mesmo resultado (válido ou inválido, conforme o sufixo); atualizar o índice em `docs/contratos/README.md` com os dois contratos novos (depende de T001, T003)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Peças compartilhadas por todas as stories: configuração, validação reutilizável, porta de repositório e cliente

**⚠️ CRITICAL**: Nenhuma user story começa antes desta fase terminar

- [ ] T005 Estender `src/config/config.module.ts` (`AppConfig` + `loadConfig`) com `rulesSource: 'file' | 'appconfig'` (variável `RULES_SOURCE`; padrão `appconfig` quando `NODE_ENV === 'production'`, senão `file`; valor desconhecido lança erro), `appconfig: { application, environment, profile }`, `rules: { pollIntervalMs, startupTimeoutMs, metricsEmf }`; com `rulesSource === 'appconfig'` as três variáveis `APPCONFIG_*` são obrigatórias (mensagem de erro cita só o nome da variável)
- [ ] T006 [P] Criar `src/rules/rules-document.validator.spec.ts` (escrever antes e ver falhar): `validateRulesDocument` aceita o `config/rules.json` e o exemplo válido; rejeita JSON ilegível, objeto sem `rules`, lista vazia, regra fora do contrato Rule v1, `ruleId` duplicado, regra `WINDOWED` ou com `window`, expressão que não compila, nenhuma regra `ACTIVE`; as mensagens de erro citam só `ruleId`/posição e a regra violada, nunca valores (FR-006, FR-007, FR-015)
- [ ] T007 Criar `src/rules/rules-document.validator.ts` com `validateRulesDocument(content: string, deps: { engine, ruleSchemaPath? }): { rules: readonly Rule[]; documentRevision?: number }`, extraindo de `rules-config.loader.ts` toda a validação (parse, envelope, Ajv 2020-12 do `rule.v1`, unicidade, `WINDOWED`, `engine.validate`, ao menos uma `ACTIVE`, congelamento) e lançando `RulesConfigError` (depende de T006)
- [ ] T008 Refatorar `src/rules/rules-config.loader.ts` para ler o arquivo e delegar a `validateRulesDocument`, mantendo as mensagens e o comportamento atuais; `rules-config.loader.spec.ts` existente continua verde sem alterações (depende de T007)
- [ ] T009 [P] Criar `src/rules/rule-source.ts` com a interface `RuleRepository { loadActiveSnapshot(): Promise<RuleSnapshot>; currentRevision(): Promise<number> }`, o token `RULE_REPOSITORY`, a interface `RuleConfigClient { start(): Promise<void>; poll(): Promise<ConfigPollResult> }`, o tipo `ConfigPollResult = { kind: 'unchanged' } | { kind: 'changed'; content: string; versionLabel?: string }` e `ConfigClientError` com categoria (`THROTTLED`, `UNAVAILABLE`, `SESSION_EXPIRED`, `ACCESS_DENIED`, `NOT_FOUND`, `UNKNOWN`)
- [ ] T010 Fazer `StaticRuleRepository` (`src/rules/static-rule.repository.ts`) implementar `RuleRepository`; trocar a injeção em `src/transactions/process-transaction.service.ts` para `@Inject(RULE_REPOSITORY) private readonly rules: RuleRepository` (os testes que fazem `new StaticRuleRepository(...)` seguem válidos); em `src/rules/rules.module.ts`, prover `RULE_REPOSITORY` com o repositório por arquivo e exportá-lo; rodar `npm test` (depende de T009)

**Checkpoint**: Fundação pronta — o comportamento atual (fonte por arquivo) continua idêntico e as stories podem começar

---

## Phase 3: User Story 1 - Alterar uma regra sem redeploy (Priority: P1) 🎯 MVP

**Goal**: Um operador publica uma nova revisão e as instâncias em execução passam a avaliar com ela, sem reinício, trocando o snapshot inteiro de uma vez.

**Independent Test**: Quickstart cenários 1 e 2. Em teste automatizado: repositório com cliente falso aplica uma revisão nova e nenhuma avaliação mistura revisões; na AWS: publicar uma revisão e ver todas as tarefas assumirem o rótulo novo.

### Tests for User Story 1 ⚠️

> Escrever primeiro e ver falhar antes da implementação

- [ ] T011 [P] [US1] Criar `src/rules/appconfig-rule.client.spec.ts` com `AppConfigDataClient` mockado: `start()` chama `StartConfigurationSession` com `RequiredMinimumPollIntervalInSeconds = 15`; `poll()` usa o token e **guarda o `NextPollConfigurationToken` de cada resposta**; corpo vazio vira `{ kind: 'unchanged' }`; corpo com `Version-Label` vira `{ kind: 'changed', content, versionLabel }` (FR-013)
- [ ] T012 [P] [US1] Criar `src/rules/appconfig-rule.repository.spec.ts` com um `RuleConfigClient` falso e relógio falso: `start()` ativa a primeira configuração e a revisão vem do `versionLabel`; um `changed` válido troca o snapshot e atualiza `currentRevision()`; um `unchanged` mantém o snapshot; o intervalo entre consultas fica em 20 s ± 10% de jitter; `loadActiveSnapshot()` devolve sempre a mesma referência até a troca
- [ ] T013 [P] [US1] Criar `test/integration/rules-atomic-swap.int-spec.ts`: avaliar transações em laço com `DeclarativeRuleEngine` enquanto o repositório alterna entre duas revisões com limites diferentes; cada avaliação lê o snapshot **uma vez** e o resultado é coerente com uma única revisão, nunca mista (FR-008, SC-007)

### Implementation for User Story 1

- [ ] T014 [US1] Criar `src/rules/appconfig-rule.client.ts` (`AppConfigRuleClient implements RuleConfigClient`) sobre `@aws-sdk/client-appconfigdata`: `StartConfigurationSession`, `GetLatestConfiguration`, leitura do `Version-Label`, substituição do token a cada resposta e mapeamento dos erros do SDK para `ConfigClientError` (429 → `THROTTLED`, `BadRequestException` → `SESSION_EXPIRED`, 5xx/rede → `UNAVAILABLE`, 403 → `ACCESS_DENIED`, 404 → `NOT_FOUND`); registrar o provider do `AppConfigDataClient` (token `APPCONFIGDATA_CLIENT`) em `src/aws/aws-clients.module.ts`, com o mesmo endpoint opcional dos demais clientes e o destroy no `AwsClientsLifecycle` (depende de T009, T011)
- [ ] T015 [US1] Criar `src/rules/appconfig-rule.repository.ts` (`AppConfigRuleRepository implements RuleRepository`): `start()` obtém e ativa a primeira configuração; um laço com `setTimeout` e jitter consulta a cada `rules.pollIntervalMs`; quando vier `changed`, chama `validateRulesDocument`, e se válido troca o snapshot por uma única atribuição de referência (revisão = `Number(versionLabel)`); `unchanged` não altera nada; `onModuleDestroy` cancela o timer; erros ainda não tratados propagam (o tratamento de falhas é a US3 e a US4) (depende de T007, T009, T012, T014)
- [ ] T016 [US1] Em `src/rules/rules.module.ts`, quando `config.rulesSource === 'appconfig'` prover `RULE_REPOSITORY` com uma fábrica assíncrona que cria `AppConfigRuleClient` + `AppConfigRuleRepository` e aguarda `start()` antes de expor o módulo; manter o caminho `file` atual; garantir que o `DeclarativeRuleEngine` é injetado (depende de T015)
- [ ] T017 [P] [US1] Criar `scripts/rules/validate-rules.ts`: CLI fino que lê o arquivo passado como argumento, chama `validateRulesDocument` com um `DeclarativeRuleEngine` real e sai com código 0 (imprime `OK <n> regras`) ou código 1 (imprime a mensagem sem valores sensíveis); executado com `ts-node` (depende de T007)
- [ ] T018 [US1] Criar `scripts/rules/publish-rules.sh` (modo de publicação): `publish-rules.sh <arquivo.json> [--strategy gradual|immediate] [--dry-run]`; (1) roda `scripts/rules/validate-rules.ts` e aborta com erro se inválido; (2) `aws appconfig create-hosted-configuration-version` com `--version-label $(date -u +%Y%m%d%H%M%S)` e `--content-type application/json`; (3) `aws appconfig start-deployment` com a estratégia escolhida (padrão `gradual`); (4) imprime rótulo (revisão), número do deployment e o comando de acompanhamento; IDs de aplicação, ambiente, perfil e estratégias vêm das variáveis `APPCONFIG_*` ou de `terraform output`; `--dry-run` só imprime os comandos (depende de T017)
- [ ] T019 [P] [US1] Criar `infra/terraform/envs/production/appconfig.tf`: `aws_appconfig_application`, `aws_appconfig_environment` `production`, `aws_appconfig_configuration_profile` `fraud-rules` (hosted, `application/json`, validador JSON Schema com `file()` do `docs/contratos/rules-document.v1.draft4.schema.json`), `aws_appconfig_deployment_strategy` `rules-gradual` (linear, 10 min, 20%, bake 5 min) e `rules-immediate` (0 min, bake 0); acrescentar em `outputs.tf` os IDs de aplicação, ambiente, perfil e estratégias
- [ ] T020 [P] [US1] Em `infra/terraform/envs/production/iam.tf`, acrescentar ao `data.aws_iam_policy_document.app` a statement `ReadRules` com `appconfig:StartConfigurationSession` e `appconfig:GetLatestConfiguration` restritas ao ARN `arn:<partição>:appconfig:<região>:<conta>:application/<app>/environment/<env>/configuration/<perfil>` (confirmar o prefixo da ação na referência do IAM, ver research D-10)
- [ ] T021 [US1] Em `infra/terraform/envs/production/ecs.tf`, acrescentar a `local.app_environment` `RULES_SOURCE = "appconfig"`, `APPCONFIG_APPLICATION`, `APPCONFIG_ENVIRONMENT`, `APPCONFIG_PROFILE` (IDs vindos de `appconfig.tf`) e remover `RULES_CONFIG_PATH`; rodar `terraform validate` em `infra/terraform/envs/production` (depende de T019)
- [ ] T022 [US1] Em `infra/terraform/README.md`, documentar a semeadura (`terraform apply` → `scripts/rules/publish-rules.sh config/rules.json --strategy immediate` → subir o serviço) e a publicação de uma alteração, com a ordem obrigatória explicada pelo fail-fast (depende de T018, T021)

**Checkpoint**: US1 funcional — uma revisão publicada chega a todas as instâncias sem redeploy e a troca é atômica

---

## Phase 4: User Story 2 - Reverter para a versão anterior das regras (Priority: P1)

**Goal**: Voltar à revisão anterior sem redeploy e, durante um rollout gradual, reverter automaticamente quando um alarme de saúde disparar.

**Independent Test**: Quickstart cenários 3 e 4. Rollback manual pelo script; rollback automático com um alarme de saúde monitorado pelo ambiente.

### Implementation for User Story 2

- [ ] T023 [US2] Estender `scripts/rules/publish-rules.sh` com `--rollback <revisão>` (resolve a versão hospedada pelo rótulo com `list-hosted-configuration-versions` e inicia um novo deployment dela; estratégia padrão `immediate`) e `--stop` (chama `stop-deployment` no deployment em andamento, com `--dry-run` imprimindo os comandos); erro claro se o rótulo não existir (depende de T018)
- [ ] T024 [US2] Em `infra/terraform/envs/production/appconfig.tf`, criar o papel IAM assumível por `appconfig.amazonaws.com` com `cloudwatch:DescribeAlarms` restrito aos alarmes monitorados e configurar `monitor { alarm_arn, alarm_role_arn }` no ambiente `production` para os alarmes de saúde já existentes em `monitoring.tf` (`dlq_not_empty` de cada DLQ e `transactions_age`); `terraform validate` (depende de T019)
- [ ] T025 [P] [US2] Em `infra/terraform/envs/production/monitoring.tf`, criar os alarmes de latência de alerta e de erros de processamento que faltam para o rollback (usar métricas disponíveis hoje, por exemplo a idade da fila e `HTTPCode`/saúde do serviço; se uma métrica ainda não existir no CloudWatch, deixar um comentário apontando a emissão EMF da US5) e incluí-los entre os monitores do ambiente em `appconfig.tf`
- [ ] T026 [US2] Em `infra/terraform/README.md`, documentar a reversão manual (`--rollback`), a parada de um rollout em andamento (`--stop`) e o rollback automático por alarme, incluindo a limitação de que o alarme só protege durante o rollout e o *bake* (research A6) (depende de T023)

**Checkpoint**: US1 e US2 funcionam; os monitores de taxa de alertas e de falhas de refresh serão acrescentados na US5, quando as métricas existirem

---

## Phase 5: User Story 3 - Documento inválido nunca entra em produção (Priority: P1)

**Goal**: Documento inválido é barrado antes da distribuição quando possível e, se chegar à instância, é rejeitado sem alterar as regras ativas.

**Independent Test**: Quickstart cenários 5a, 5b e 6a. Documentos inválidos de cada categoria não mudam a revisão de nenhuma instância e o motivo é registrado sem valores sensíveis.

### Tests for User Story 3 ⚠️

- [ ] T027 [P] [US3] Acrescentar a `src/rules/appconfig-rule.repository.spec.ts` os casos de rejeição em runtime: documento inválido (contrato, expressão, `ruleId` duplicado, `WINDOWED`, nenhuma `ACTIVE`) mantém o snapshot e a revisão; conteúdo com `versionLabel` ausente ou não numérico é rejeitado; o log `rules.document.rejected` traz só `ruleId`/regra violada; nenhuma transação deixa de ser avaliada durante a rejeição (FR-007, FR-015)

### Implementation for User Story 3

- [ ] T028 [US3] Em `src/rules/appconfig-rule.repository.ts`, tratar a rejeição em runtime: capturar `RulesConfigError` de `validateRulesDocument` e a ausência de rótulo numérico, manter o snapshot, registrar `rules.document.rejected` no `JsonLogger` (apenas `ruleId` e regra violada) e incrementar o contador interno de falhas de refresh; na partida, o mesmo erro impede iniciar (a política de partida completa é a US4) (depende de T015, T027)
- [ ] T029 [P] [US3] Cobrir com exemplos, em `docs/contratos/examples/`, as categorias estruturais que o validador draft 4 deve barrar na publicação pelo console (campo obrigatório ausente, `ruleId` fora do padrão, `kind: WINDOWED` sem `window`, `severity` inválida) e confirmar que `npm run contracts:validate` passa com o teste de equivalência dos dois schemas (depende de T004)
- [ ] T030 [US3] Em `scripts/rules/publish-rules.sh`, tornar a pré-validação obrigatória e explícita: sair com código ≠ 0 e a mensagem de `validate-rules.ts` sem criar a versão hospedada quando inválido; nenhum caminho do script pode pular a validação (depende de T018)

**Checkpoint**: US1, US2 e US3 — mudar, reverter e rejeitar documentos ruins nas três camadas

---

## Phase 6: User Story 4 - Continuar operando quando o serviço de configuração falha (Priority: P2)

**Goal**: Instâncias em execução mantêm a última versão válida; instâncias novas sem configuração não sobem.

**Independent Test**: Quickstart cenários 7 e 8. Bloquear o acesso em runtime não afeta o processamento; uma instância nova sem acesso falha em ~45 s com erro claro.

### Tests for User Story 4 ⚠️

- [ ] T031 [P] [US4] Acrescentar a `src/rules/appconfig-rule.repository.spec.ts` (relógio falso): na partida, falhas transitórias são repetidas com *backoff* exponencial e a terceira tentativa bem-sucedida ativa a configuração; esgotado `startupTimeoutMs` lança erro claro (`rules.startup.failed`) e `start()` rejeita; em runtime, `THROTTLED`/`UNAVAILABLE`/`ACCESS_DENIED` mantêm o snapshot, incrementam o contador de falhas e o laço continua; `SESSION_EXPIRED` reabre a sessão no ciclo seguinte (FR-010, FR-012, FR-014)
- [ ] T032 [P] [US4] Criar `test/integration/rules-source-outage.int-spec.ts`: com o repositório em execução e o cliente falso passando a falhar, o `ProcessTransactionService` continua avaliando transações com o último snapshot, sem exceção nem aumento de latência relevante (SC-003)

### Implementation for User Story 4

- [ ] T033 [US4] Em `src/rules/appconfig-rule.repository.ts`, implementar a política de partida (retry com backoff exponencial de 1 s com teto, prazo `rules.startupTimeoutMs`, erro `rules.startup.failed` sem token nem conteúdo) e a política de runtime (manter snapshot em qualquer `ConfigClientError`, reabrir a sessão em `SESSION_EXPIRED`, contar falhas, nunca interromper o laço) (depende de T028, T031)
- [ ] T034 [P] [US4] Em `src/main.ts` (ou no bootstrap equivalente), garantir que o erro de partida das regras encerra o processo com código ≠ 0 e uma linha de log estruturada; confirmar com um teste que a falha do módulo de regras impede o `listen` (depende de T016)
- [ ] T035 [P] [US4] Em `infra/terraform/envs/production/network.tf`, acrescentar `appconfigdata` a `local.interface_endpoints` (perfil `full`) e conferir que o grupo de segurança do endpoint e as regras de saída HTTPS de `local.aws_clients` o cobrem; confirmar o nome do serviço de endpoint com `aws ec2 describe-vpc-endpoint-services` e anotar a confirmação no `research.md` (A11, D-12); `terraform validate`

**Checkpoint**: US4 — a queda do AppConfig não derruba o processamento e a partida sem regras falha de forma clara

---

## Phase 7: User Story 5 - Enxergar defasagem e rollout travado (Priority: P2)

**Goal**: Métricas e alarmes mostram a revisão de cada instância, a idade do refresh e as falhas, e alimentam o rollback automático.

**Independent Test**: Quickstart cenários 6b e 9. Falhas forçadas e uma revisão divergente fazem os alarmes dispararem; um documento rejeitado pelas instâncias reverte o deployment sozinho.

### Tests for User Story 5 ⚠️

- [ ] T036 [P] [US5] Criar `src/observability/metrics-emf.publisher.spec.ts`: a cada intervalo escreve uma linha JSON no formato EMF (namespace `FraudDetector/Rules`, métricas `RulesActiveRevision`, `RulesLastRefreshAgeSeconds`, `RulesRefreshFailures` e `AlertsCreated` como **delta** desde a emissão anterior), sem dimensão por tarefa e sem PII; nada é emitido quando `rules.metricsEmf` é falso
- [ ] T037 [P] [US5] Acrescentar a `src/rules/appconfig-rule.repository.spec.ts` as asserções de métricas: `rules_active_revision`, `rules_last_refresh_age_seconds` (zerada a cada consulta bem-sucedida, inclusive `unchanged`) e `rules_refresh_failures_total` em `InMemoryMetrics`

### Implementation for User Story 5

- [ ] T038 [US5] Em `src/rules/appconfig-rule.repository.ts`, publicar em `InMemoryMetrics` as séries `rules_active_revision`, `rules_last_refresh_age_seconds` e `rules_refresh_failures_total` (o gauge de idade calculado na leitura do `/metrics` ou a cada ciclo), e registrar os eventos `rules.refresh.ok`, `rules.refresh.failed` e `rules.startup.failed` no `JsonLogger` (depende de T033, T037)
- [ ] T039 [US5] Criar `src/observability/metrics-emf.publisher.ts` (provider no `ObservabilityModule`): a cada 60 s lê o `InMemoryMetrics` e escreve a linha EMF no stdout (formato do §Métricas de `data-model.md`), com deltas para contadores; ligado por `rules.metricsEmf` (`RULES_METRICS_EMF`, `true` em `ecs.tf`); expor em `InMemoryMetrics` o acesso de leitura necessário sem quebrar o `render()` (depende de T036, T038)
- [ ] T040 [P] [US5] Em `infra/terraform/envs/production/monitoring.tf`, criar os alarmes `rules-refresh-stale` (`RulesLastRefreshAgeSeconds` máx. > 90 s por 3 períodos de 1 min), `rules-revision-diverged` (métrica `MAX − MIN` de `RulesActiveRevision` > 0 por 20 min, tolerância em variável `rules_divergence_minutes` com padrão 20 em `variables.tf`), `rules-refresh-failures` (`RulesRefreshFailures` > 0 em 2 de 3 períodos) e `rules-alert-rate-anomaly` (`AlertsCreated` com banda de detecção de anomalia), todos notificando o tópico `ops`
- [ ] T041 [US5] Em `infra/terraform/envs/production/appconfig.tf`, acrescentar `rules-refresh-failures` e `rules-alert-rate-anomaly` aos monitores de rollback automático do ambiente e ao `cloudwatch:DescribeAlarms` do papel dos monitores; `terraform validate` (depende de T024, T040)
- [ ] T042 [P] [US5] Em `infra/terraform/envs/production/ecs.tf`, definir `RULES_METRICS_EMF = "true"` em `local.app_environment` e confirmar que o `awslogs` já cobre o stdout do contêiner da aplicação (depende de T021)
- [ ] T043 [P] [US5] Estender `src/health/metrics.controller.spec.ts` para garantir que `/metrics` expõe as três séries de regras e que nenhum rótulo delas é de alta cardinalidade nem contém PII

**Checkpoint**: US5 — defasagem, divergência e falhas visíveis e ligadas ao rollback automático

---

## Phase 8: User Story 6 - Desenvolver e testar localmente sem a AWS (Priority: P3)

**Goal**: A fonte de regras é selecionável por configuração; dev e testes usam o arquivo e produção usa o AppConfig por padrão.

**Independent Test**: Quickstart cenário 10 e a seção 1 do quickstart.

### Tests for User Story 6 ⚠️

- [ ] T044 [P] [US6] Criar `src/config/config.module.spec.ts`: `RULES_SOURCE` ausente com `NODE_ENV=production` resolve `appconfig`; ausente fora de produção resolve `file`; `file` e `appconfig` explícitos são respeitados; valor desconhecido lança erro; `appconfig` sem `APPCONFIG_*` lança erro citando só o nome da variável; `file` não exige `APPCONFIG_*`
- [ ] T045 [P] [US6] Criar `src/rules/rules.module.spec.ts`: com `rulesSource = 'file'` o módulo expõe um `StaticRuleRepository` carregado de `config/rules.json` e **não** instancia o cliente do AppConfig; com `appconfig` o arquivo **não** é lido (espiar `fs.readFileSync` no caminho de `rulesConfigPath`) (FR-011, FR-018)

### Implementation for User Story 6

- [ ] T046 [US6] Ajustar `src/rules/rules.module.ts` e `src/config/config.module.ts` até T044 e T045 passarem, garantindo que em modo `appconfig` o `RULES_CONFIG_PATH` é ignorado e que o padrão de produção é `appconfig` (depende de T005, T016)
- [ ] T047 [P] [US6] Em `docker-compose.yml`, `README.md` e `.env.example`, deixar explícito que o ambiente local usa `RULES_SOURCE=file` e o arquivo `config/rules.json`, e que produção usa o AppConfig; conferir que `npm run infra:up`, `npm test` e `npm run test:int` continuam funcionando sem acesso à AWS (SC-008)

**Checkpoint**: Todas as user stories funcionais

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Políticas de acesso, documentação, verificação ponta a ponta e carga

- [ ] T048 [P] Em `infra/terraform/envs/production/iam.tf` e `variables.tf`, criar a política gerenciada `rules-operator` (`appconfig:CreateHostedConfigurationVersion`, `ListHostedConfigurationVersions`, `StartDeployment`, `StopDeployment`, `GetDeployment`, `ListDeployments`, `GetConfigurationProfile`, restritas à aplicação, ao ambiente e ao perfil) e um papel assumível por `var.rules_operator_principals` (lista, padrão vazia), separado das políticas de deploy de código e da role `app` (FR-023); `terraform validate`
- [ ] T049 [P] Confirmar nos documentos oficiais e anotar no `research.md` (A12, D-10, D-12) o prefixo da ação IAM do plano de dados, o nome do serviço de endpoint de VPC e se um perfil com CMK exige `kms:Decrypt`; ajustar `iam.tf`, `network.tf` e a política `rules-operator` se algo divergir
- [ ] T050 [P] Atualizar `docs/adr/ADR-03-motor-de-regras.md` com as decisões do plano (rótulo de versão numérico, três camadas de validação sem Lambda, SDK direto em vez do AppConfig Agent, métricas EMF e rede) e registrar o ADR no `docs/adr/README.md`
- [ ] T051 Rodar `npm run lint`, `npm test`, `npm run test:int` (com `npm run infra:up`) e `npm run contracts:validate`; corrigir o que falhar (portões de qualidade da constituição)
- [ ] T052 Executar `terraform validate` e `terraform plan` em `infra/terraform/envs/production` para os perfis `lean` e `full`, revisar o plano (sem recursos inesperados) e anotar o resultado
- [ ] T053 Executar na AWS os cenários do `specs/002-appconfig-dynamic-rules/quickstart.md` (1, 3, 4, 5b, 6b, 7, 8, 9 e 10), registrando o resultado de cada um; ajustar o que divergir
- [ ] T054 Repetir o teste k6 existente (`infra/terraform/scripts/loadtest.sh`) com uma publicação de regras no meio da execução e confirmar latência de alerta ≤ 500 ms (p99) sem degradação na janela da troca (constituição V, quickstart §4)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências; T001 antes de T004.
- **Foundational (Phase 2)**: depende de Setup; **bloqueia todas as stories**.
- **US1 (P1)**: depende da Fundação. É o MVP.
- **US2 (P1)**: depende de US1 (script e `appconfig.tf` existem).
- **US3 (P1)**: depende de US1 (repositório e script) e de T004 (contratos).
- **US4 (P2)**: depende de US3 (T028) por tocar o mesmo repositório; T035 é independente.
- **US5 (P2)**: depende de US4 para as métricas do repositório (T038) e de US2 para os monitores (T041).
- **US6 (P3)**: depende da Fundação e de US1 (T016); pode correr em paralelo a US2 a US5.
- **Polish (Phase 9)**: depende das stories desejadas.

### Dentro de cada story

- Testes primeiro (devem falhar), depois implementação; contratos antes de código (constituição II).
- As tarefas T015, T028, T033 e T038 editam o mesmo arquivo (`appconfig-rule.repository.ts`) e ficam **sequenciais**; as tarefas de Terraform em `appconfig.tf` (T019, T024, T041) também.

### Parallel Opportunities

- Setup: T002 e T003 em paralelo.
- Fundação: T006 e T009 em paralelo; T005 independe deles.
- US1: T011, T012 e T013 em paralelo; T017, T019 e T020 em paralelo depois da fundação.
- US4: T031, T032 e T035 em paralelo.
- US5: T036, T037, T040, T042 e T043 em paralelo.
- US6 pode ser conduzida por outra pessoa enquanto US2 a US5 avançam.

### Parallel Example: User Story 1

```text
Tarefas de teste em paralelo:
  T011 src/rules/appconfig-rule.client.spec.ts
  T012 src/rules/appconfig-rule.repository.spec.ts
  T013 test/integration/rules-atomic-swap.int-spec.ts
Depois, em paralelo:
  T017 scripts/rules/validate-rules.ts
  T019 infra/terraform/envs/production/appconfig.tf
  T020 infra/terraform/envs/production/iam.tf
```

---

## Implementation Strategy

### MVP First (apenas US1)

1. Setup e Fundação (comportamento atual preservado).
2. US1: cliente, repositório, módulo, script de publicação e Terraform básico.
3. **Parar e validar**: publicar uma revisão e ver as instâncias assumirem sem reinício (quickstart 1 e 2).

### Entrega incremental

1. US1 (mudar) → US2 (reverter) → US3 (rejeitar inválido): as três P1 formam o requisito do desafio.
2. US4 (resiliência) → US5 (observabilidade e rollback automático completo).
3. US6 (ergonomia local) pode entrar a qualquer momento depois da US1.
4. Polish: política de operadores, ADR, portões de qualidade, plano de infra, cenários na AWS e carga.

### Observações

- `[P]` = arquivos diferentes e sem dependência de tarefa incompleta.
- Não fazer commit nem push sem pedido explícito (AGENTS.md); parar para revisão ao final de cada fase.
- Validar o Terraform (`terraform validate`/`plan`) antes de qualquer `apply`; o `apply` é decisão do usuário.
