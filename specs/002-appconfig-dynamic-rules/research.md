# Pesquisa (Fase 0): Regras dinâmicas via AppConfig

Todas as decisões abaixo resolvem pontos que a spec deixou para o plano ou que a pesquisa na documentação da AWS (consultada em 2026-10-10) contradisse. Nenhum `NEEDS CLARIFICATION` resta.

## Achados que alteram o desenho

| # | Achado | Impacto |
|---|--------|---------|
| A1 | O validador **JSON Schema** do AppConfig só suporta o **draft 4**; para outra versão a AWS manda usar validador **Lambda**. O `rule.v1.schema.json` usa o **2020-12** | O validador do perfil não pode ser o `rule.v1` direto; usa-se um espelho estrutural em draft 4 (ver D-04) |
| A2 | `GetLatestConfiguration` devolve apenas o cabeçalho **`Version-Label`** (rótulo **definido pelo usuário** na publicação). O **número da versão** do hosted configuration **não** vem na API de dados | A clarificação Q3 ("número de versão do AppConfig") precisa ser ajustada (ver D-03) |
| A3 | Cada token de sessão vale para **uma** chamada; a resposta traz `NextPollConfigurationToken`, que deve substituir o anterior. O token expira em até 24 h, e token expirado gera `BadRequestException` | O cliente guarda o token novo a cada chamada e reabre a sessão ao receber `BadRequestException` (FR-014) |
| A4 | O intervalo de poll padrão do serviço é **60 s**; só vale 15 a 30 s se a sessão pedir `RequiredMinimumPollIntervalInSeconds` | A sessão é aberta com esse parâmetro (D-02) |
| A5 | Corpo vazio significa "cliente já tem a versão mais recente" (e `Version-Label` vem vazio) | Confirma FR-013: vazio = sem mudança |
| A6 | Rollback automático olha alarmes do CloudWatch **durante o rollout e no *bake time***, via papel IAM que o AppConfig assume. Rollback de um deployment já concluído é um **novo deployment** da versão anterior | O alarme só protege dentro da janela; reversão posterior usa a estratégia imediata (D-05) |
| A7 | O AppConfig não empurra configuração: cada instância só vê a mudança no próximo poll. Em rollout gradual, instâncias ficam **temporariamente em revisões diferentes** | A tolerância do alarme de divergência deve ser maior que rollout + *bake* (D-07) |
| A8 | O AppConfig só é emulado no LocalStack em planos pagos | Testes locais usam um cliente falso, sem AppConfig real (D-09) |
| A9 | Hoje as métricas são **em memória, expostas por `/metrics` em texto**; o Terraform só tem alarmes sobre métricas `AWS/*`. Nada publica métrica customizada no CloudWatch | Alarmes de defasagem e de taxa de alertas exigem um caminho de métrica para o CloudWatch (D-06) |
| A10 | O `DeclarativeRuleEngine` é uma classe pura (sem dependências de Nest além do decorator), e o `loadRulesConfig` já concentra a validação | A validação pode ser extraída (`validateRulesDocument`) e reutilizada na instância e no script de publicação (D-04) |
| A11 | No perfil `full` do Terraform (`enable_nat=false`, `enable_vpc_endpoints=true`) a saída das tarefas só passa por VPC endpoints, e a lista em `network.tf` não inclui o AppConfig. O endpoint de dados responde em `appconfigdata.<região>.amazonaws.com` | Sem um endpoint `appconfigdata`, as tarefas não alcançam o AppConfig e falham na partida (D-12) |
| A12 | A documentação consultada não confirmou se um perfil com chave KMS gerenciada pelo cliente exige `kms:Decrypt` do chamador da API de dados | Item a confirmar antes de usar CMK no perfil (D-12) |
| A13 | Um ambiente do AppConfig aceita no máximo **5 monitores**; a documentação não afirma que alarmes compostos sejam aceitos, mas exemplos do CDK passam um `CompositeAlarm` como monitor | Todos os sinais de rollback ficam num alarme composto (OR) com um único monitor; confirmar na AWS com os cenários 4 e 6b do quickstart (D-06) |

## Decisões

### D-01 Cliente de acesso: SDK direto, sem *sidecar* do AppConfig Agent

- **Decisão:** usar `@aws-sdk/client-appconfigdata` (`StartConfigurationSession` + `GetLatestConfiguration`) dentro do próprio serviço.
- **Racional:** precisamos controlar a validação antes de ativar, a troca atômica, o fail-fast na partida e as métricas de defasagem; o Agent esconderia isso atrás de um cache HTTP local. O volume é irrisório (cerca de 3 chamadas por minuto por tarefa).
- **Alternativas:** *AppConfig Agent* como contêiner *sidecar* (recomendado pela AWS), **descartado** por:
  - criar duas camadas de polling (aplicação → Agent → AppConfig), cujos intervalos se somam e pressionam o SLO de frescor de 30 s;
  - servir cache de forma opaca: se o AppConfig cair, a aplicação não sabe há quanto tempo está desatualizada, e essa idade é a base dos alarmes de defasagem;
  - dificultar o fail-fast na partida (a resposta do Agent vem de outra camada);
  - adicionar um contêiner por tarefa (CPU, memória, ordem de inicialização, outro ponto de falha);
  - abrir um endpoint HTTP local sem autenticação, legível por qualquer contêiner da tarefa ou por uma falha de SSRF na aplicação (impacto baixo, pois são regras e não segredos, mas é superfície que o SDK não tem);
  - não dispensar a validação nem a troca atômica na aplicação, então o ganho é pequeno.
  O custo de não usar o Agent é manter cerca de 100 linhas de código de cliente (sessão, token de uso único, expiração, vazio = sem mudança), cobertas por testes com cliente falso. Também não confirmei se a resposta HTTP do Agent expõe o rótulo de versão usado como revisão.
  Lambda extension (não se aplica a ECS).
- **Dependência nova:** `@aws-sdk/client-appconfigdata`, justificada aqui (constituição, Restrições Técnicas).

### D-02 Polling e sessão

- **Decisão:** abrir a sessão com `RequiredMinimumPollIntervalInSeconds = 15` e consultar a cada **20 s ± 10% de jitter** (`RULES_POLL_INTERVAL_MS=20000`). Substituir o token a cada resposta. Em `BadRequestException` (token expirado ou inválido), reabrir a sessão no ciclo seguinte. Em `ThrottlingException`/5xx/rede, manter o snapshot e repetir no próximo ciclo.
- **Racional:** 20 s deixa margem para o SLO de frescor de 30 s (RNF-40) e o jitter evita sincronismo entre tarefas.
- **Custo:** `GetLatestConfiguration` é cobrada por chamada; a ordem de grandeza (cerca de 130 mil chamadas por tarefa por mês) é de centavos de dólar. Confirmar na tabela de preços vigente.

### D-03 Identificador de revisão: rótulo numérico definido na publicação (ajusta a Q3)

- **Decisão:** toda publicação cria a versão hospedada com `--version-label` igual a `r` + um **inteiro monotônico**, o carimbo UTC (`rYYYYMMDDHHMMSS`; o AppConfig exige ao menos um caractere não numérico, confirmado ao publicar na AWS real). A instância remove o `r` e usa o inteiro como revisão. O script de publicação (`scripts/rules/publish-rules.sh`) é o único caminho suportado e define o rótulo. A instância lê o `Version-Label` da resposta e o usa como **revisão ativa**. Se a resposta trouxer conteúdo mas rótulo vazio ou não numérico, a versão é **rejeitada** (conteúdo sem revisão rastreável não é ativado).
- **Racional:** o número de versão do hosted configuration não chega à API de dados (A2); o rótulo é a única via sem depender de campo editado à mão no documento. Ser inteiro permite alarme de divergência com `MAX − MIN` no CloudWatch (D-07).
- **Efeito na spec:** a Clarification Q3 e os trechos que citam "número de versão do AppConfig" passam a dizer "rótulo de versão numérico definido na publicação". Ajuste feito junto com este plano.
- **Alternativas:** hash do conteúdo calculado pela instância (não é numérico, não permite `MAX − MIN` e não mostra ordem); campo `revision` dentro do documento (editável, repetível, descartado na Q3).

### D-04 Validação em três camadas, sem Lambda

- **Decisão:**
  1. **Pré-validação no `publish-rules.sh`:** antes de criar a versão, o script roda a função pura `validateRulesDocument(content, schema, engine)` (a mesma da instância): contrato `rule.v1` (Ajv 2020-12), sintaxe e custo da expressão (`DeclarativeRuleEngine.validate`), rejeição de `WINDOWED`, `ruleId` duplicado e ao menos uma regra `ACTIVE`. Documento inválido nem é enviado.
  2. **Validador JSON Schema draft 4 no perfil do AppConfig** ([contracts/rules-document.v1.draft4.schema.json](contracts/rules-document.v1.draft4.schema.json)): espelho **estrutural** do `rule.v1` (tipos, campos obrigatórios, padrão do `ruleId`, enums, limites). Cobre quem publicar pelo console da AWS, sem passar pelo script, e atende ao FR-005. O schema foi conferido contra o `config/rules.json` atual (aceita) e contra uma regra mal formada (rejeita).
  3. **Revalidação na instância**, com a mesma função, antes de ativar (FR-006, FR-007). Se um documento semanticamente inválido escapar das camadas 1 e 2, todas as instâncias o rejeitam e mantêm a revisão anterior; a métrica `RulesRefreshFailures` sobe e, por ser **monitor de rollback** do ambiente (D-06), o AppConfig reverte o deployment sozinho dentro da janela de rollout e de *bake*.
- **Garantia de equivalência:** o `contracts:validate` ganha um teste que roda os exemplos estruturais (válidos e inválidos) nos dois schemas (2020-12 e draft 4) e exige o mesmo resultado. O draft 4 precisa do pacote `ajv-draft-04` como devDependency (ou o `Draft4Validator` equivalente), que é só de teste.
- **Racional:** mantém a validação completa com uma só implementação (script e instância), cobre o caminho do console com um schema barato e transforma o erro semântico residual em reversão automática, sem Lambda. Um Lambda validador foi descartado por custo de complexidade desproporcional: componente a mais, empacotamento (`esbuild`), permissão cruzada do AppConfig e outro ponto de falha, para validar poucas dezenas de regras.
- **Limitação aceita:** um erro semântico publicado pelo console só é barrado na camada 3, ou seja, depois de distribuído. O dano é nulo (as instâncias seguem na revisão boa) e o erro aparece no alarme e na reversão automática. O validador Lambda fica como gatilho de revisão se houver muitos operadores publicando pelo console.
- **Alternativas:** validador Lambda (descartado, acima); somente validar na instância (o rollout "terminaria" com conteúdo ruim sem aviso, sem a camada 2 nem o monitor de falhas).

### D-05 Estratégias de deployment e rollback

- **Decisão:** duas estratégias customizadas no Terraform:
  - `rules-gradual` (padrão, FR-022): linear, **10 min** de duração, fator de crescimento **20%**, ***bake* de 5 min**, com os alarmes de rollback ligados ao ambiente.
  - `rules-immediate`: duração 0, *bake* 0, para urgências e para **reverter** uma versão já concluída.
- **Rollback manual:** novo deployment da versão anterior (com `rules-immediate` quando for urgente); durante um rollout em andamento, `StopDeployment`. **Rollback automático:** alarmes monitorados no ambiente (D-06), via papel IAM assumível por `appconfig.amazonaws.com` com `cloudwatch:DescribeAlarms`.
- **Racional:** o padrão gradual dá a janela de observação (A6); o imediato mantém o SC-002 (reverter com o mesmo efeito e prazo de uma publicação normal) quando o tempo é crítico.
- **Alternativas:** estratégia exponencial (mais complexa sem ganho para poucas tarefas); só a estratégia imediata (perde a proteção por alarme).

### D-06 Métricas e alarmes: linha de log + filtros de métrica, sem nova dependência

- **Decisão:** um publicador leve (`MetricsLogPublisher`) escreve a cada 60 s uma linha JSON `rules.metrics` no stdout, que o driver `awslogs` já envia ao CloudWatch Logs; filtros de métrica (`aws_cloudwatch_log_metric_filter`, Terraform) extraem os campos numéricos como métricas do namespace `FraudDetector/Rules`. Foi preferido ao *Embedded Metric Format* porque a extração de EMF a partir do `awslogs` no Fargate não pôde ser confirmada na documentação, enquanto filtros de métrica são determinísticos. Métricas:
  - `RulesActiveRevision` (gauge, sem dimensão de tarefa);
  - `RulesLastRefreshAgeSeconds` (gauge);
  - `RulesRefreshFailures` (contador por intervalo);
  - `AlertsCreated` (contador por intervalo, vindo do `alerts_total` já existente), usado pelo alarme de taxa de alertas.
  O `/metrics` em texto continua existindo e ganha as mesmas séries (`rules_active_revision`, `rules_last_refresh_age_seconds`, `rules_refresh_failures_total`).
- **Alarmes** (Terraform, em `monitoring.tf`, ações no tópico `ops`):
  - **Defasagem:** `RulesLastRefreshAgeSeconds` (máximo) > 90 s por 3 períodos de 1 min. O SLO de frescor é 30 s, e 90 s tolera três ciclos de poll perdidos antes de alarmar.
  - **Rollout travado:** métrica `MAX − MIN` de `RulesActiveRevision` > 0 por mais de **20 min** (maior que 10 min de rollout + 5 min de *bake*, A7).
  - **Rollback automático (monitores do ambiente):** os alarmes de saúde já existentes (DLQ não vazia e idade da fila de transações, que cobre erros de processamento, que terminam na DLQ, e atraso), um alarme de **taxa de alertas** sobre `AlertsCreated` com banda de detecção de anomalia e um alarme de **falhas de refresh** (`RulesRefreshFailures` > 0 em 2 de 3 períodos de 1 min). Este último é o que reverte sozinho um documento que passe pelo schema estrutural mas seja rejeitado pelas instâncias (D-04).
- **Latência de alerta:** não é monitor de rollback, porque `alert_latency_ms` existe só em memória e publicá-la exigiria guardar o máximo por intervalo. O limite de 500 ms (p99) é verificado no teste de carga com publicação de regras no meio da execução (T053).
- **Limitação registrada:** a detecção de anomalia do CloudWatch precisa de dados históricos para ter uma banda confiável; no início o alarme é pouco sensível. O limite e a linha de base reais ficam para a calibração em ambiente (teste de carga).
- **Racional:** a linha de log com filtros dispensa o SDK do CloudWatch no caminho da aplicação e reaproveita o log que já existe. Chamada à API de métricas dentro do processo seria mais uma dependência externa a proteger (constituição IV).
- **Alternativas:** `PutMetricData` direto (nova dependência e I/O externo); exportador Prometheus/ADOT (sidecar, fora de escopo).

### D-07 Tolerância do alarme de divergência

- **Decisão:** 20 min (maior que rollout 10 min + *bake* 5 min), configurável por variável do Terraform. O valor resolve a pendência "Deferred" da etapa de clarificação.

### D-08 Fonte padrão e partida

- **Decisão:** `RULES_SOURCE` aceita `file` e `appconfig`. O **padrão do código** é `file` apenas quando `NODE_ENV !== 'production'`; em produção, a ausência de `RULES_SOURCE` equivale a `appconfig` (FR-018). Com `appconfig`, o módulo de regras tenta obter a primeira configuração com *retry* e *backoff* exponencial (1 s, 2 s, 4 s … com teto) por **até 45 s** (`RULES_STARTUP_TIMEOUT_MS`); esgotado o prazo, lança erro e o processo não inicia (FR-010, e o ECS reverte o deploy pelo *circuit breaker*). Com `file`, o comportamento atual é preservado.
- **Racional:** mantém o contrato já existente ("config ausente ou inválida impede o serviço de iniciar") e evita um fallback silencioso (FR-011).

### D-09 Estratégia de teste

- **Decisão:** o acesso ao AppConfig fica atrás de uma interface mínima (`RuleConfigClient` com `start()` e `poll()`), injetada por token. Os testes unitários usam um cliente falso controlável (respostas vazias, novas, inválidas, erros, expiração de token); um teste de integração do módulo cobre a troca atômica sob carga de avaliação; os testes de contrato validam o documento de regras. A verificação real contra o AppConfig é um passo do `quickstart.md` em ambiente AWS.
- **Racional:** o AppConfig não roda no LocalStack gratuito (A8). A interface tem duas implementações reais (AppConfig e arquivo), atendendo ao critério da constituição I para introduzir uma abstração.

### D-10 Papéis e permissões (FR-023)

- **Decisão:**
  - **Instâncias** (`aws_iam_role.app`): `appconfig:StartConfigurationSession` e `appconfig:GetLatestConfiguration` apenas no ARN do perfil de configuração do ambiente.
  - **Operadores de fraude:** uma política gerenciada `rules-operator` (criar versão hospedada, listar versões, iniciar e parar deployment, ler o status) restrita à aplicação, ao ambiente e ao perfil, mais um papel assumível por uma lista de principais (`rules_operator_principals`, variável). Separada da política do pipeline de deploy.
  - **Auditoria:** as ações de gerenciamento do AppConfig já entram no CloudTrail existente (eventos de gerenciamento); não é preciso eventos de dados.
- **Ação IAM (a confirmar):** o prefixo das ações de leitura é `appconfig` (o exemplo de requisição na documentação assina com o serviço `appconfig`), ou seja, `appconfig:StartConfigurationSession` e `appconfig:GetLatestConfiguration`. Confirmar na referência de autorização de serviços do IAM antes de escrever a política.
- **Alternativas:** deixar o operador com o mesmo acesso dos administradores de infraestrutura (descartado na Q4).

### D-11 Semeadura inicial

- **Decisão:** o AppConfig só responde à `StartConfigurationSession` depois de existir ao menos um deployment concluído. O primeiro deployment é feito pelo mesmo script `publish-rules.sh` (a partir do `config/rules.json`), executado uma vez após o `terraform apply`, antes de subir o serviço. O Terraform cria a aplicação, o ambiente, o perfil, as estratégias, os alarmes e as permissões, mas **não** a versão de regras, porque o recurso do provedor não define o rótulo de versão exigido por D-03.
- **Efeito:** sem a semeadura, as tarefas falham na partida com erro claro, o comportamento desejado (fail-fast).

### D-12 Rede e criptografia

- **Rede:** adicionar `appconfigdata` à lista `interface_endpoints` em `network.tf` (perfil `full`, `enable_vpc_endpoints=true`), com o grupo de segurança do endpoint e a regra de saída HTTPS já cobertos por `local.aws_clients`. No perfil `lean`, o NAT cobre o acesso. Sem esse endpoint, no `full` as tarefas falham na partida (fail-fast, erro claro). O nome do serviço de endpoint (`com.amazonaws.<região>.appconfigdata`) deve ser confirmado com `aws ec2 describe-vpc-endpoint-services`.
- **Criptografia em repouso:** padrão da AWS (chave própria da AWS) para o perfil, suficiente porque o documento de regras não contém dados pessoais. Se um dia o perfil usar a CMK do projeto (`enable_cmk`), confirmar se a role da instância precisa de `kms:Decrypt` (A12) e incluí-la na política da role `app` e na política da chave.
- **Transporte e autenticação:** TLS e SigV4 com a task role, como os demais serviços; sem endpoint local sem autenticação (D-01).

## Confirmações feitas na implementação (2026-10-10)

- **Endpoint de VPC:** o nome do serviço de PrivateLink do plano de dados é `com.amazonaws.<região>.appconfigdata` (página de serviços integrados ao PrivateLink da AWS). Adicionado a `local.interface_endpoints` em `network.tf`. A confirmação com `aws ec2 describe-vpc-endpoint-services` não foi possível por falta de credenciais AWS no ambiente de desenvolvimento; repetir antes do `apply` no perfil `full`.
- **Ação IAM:** `StartConfigurationSession` e `GetLatestConfiguration` pertencem ao serviço `appconfigdata`, mas as ações do IAM têm o prefixo `appconfig:` (Service Authorization Reference). A política da role `app` está correta.
- **CMK:** o perfil usa a chave padrão da AWS; a necessidade de `kms:Decrypt` com CMK (A12) segue **não confirmada** e não se aplica enquanto o perfil não usar CMK.
- **Limite de monitores:** no máximo 5 por ambiente (A13); resolvido com um alarme composto. Que o AppConfig aceite alarme composto como monitor deve ser conferido nos cenários 4 e 6b do quickstart.
- **Métricas:** a extração de EMF a partir do `awslogs` no Fargate não pôde ser confirmada; D-06 usa linha de log + filtros de métrica.
- **Alarmes em ALARM na publicação:** se algum alarme monitorado já estiver em ALARM quando o deployment começa (por exemplo, DLQ não vazia), o AppConfig reverte logo; documentado no README de infraestrutura.

## Pendências para calibração (não bloqueiam o plano)

- Faixa e sensibilidade do alarme de taxa de alertas (depende de dados de produção).
- Valor final do tempo de partida (45 s) após medir o tempo real de `StartConfigurationSession` na AWS.
- Confirmar com credenciais AWS o nome do serviço de endpoint (`appconfigdata`) e, se o perfil passar a usar CMK, a necessidade de `kms:Decrypt` (A12).
