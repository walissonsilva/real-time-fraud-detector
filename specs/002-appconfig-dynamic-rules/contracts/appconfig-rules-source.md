# Contrato operacional: fonte de regras no AppConfig

Descreve as interfaces que esta feature expõe ou consome. O documento de regras tem o schema em [rules-document.v1.schema.json](rules-document.v1.schema.json) (2020-12, referência) e o espelho estrutural [rules-document.v1.draft4.schema.json](rules-document.v1.draft4.schema.json) (draft 4, usado como validador do perfil, porque o AppConfig só valida o draft 4). Ambos devem ser levados a `docs/contratos/` e incluídos no `contracts:validate` com um teste de equivalência (ver tarefas).

## 1. Recursos no AppConfig (Terraform)

| Recurso | Valor |
|---------|-------|
| Aplicação | `${var.name}` |
| Ambiente | `production`, com os monitores de alarme de rollback (papel IAM assumível por `appconfig.amazonaws.com`): saúde do processamento, taxa de alertas e falhas de refresh |
| Perfil de configuração | `fraud-rules`, tipo *hosted*, `application/json`, validador **JSON Schema draft 4** (`rules-document.v1.draft4.schema.json`), criptografia padrão da AWS |
| Estratégia padrão | `rules-gradual`: linear, 10 min, 20% por passo, *bake* 5 min |
| Estratégia de urgência | `rules-immediate`: 0 min, *bake* 0 |

## 2. Publicar regras (operador): `scripts/rules/publish-rules.sh`

```text
publish-rules.sh <arquivo.json> [--strategy gradual|immediate]
```

1. **Pré-valida** o arquivo com `validateRulesDocument` (contrato, expressão, `ruleId` único, sem `WINDOWED`, ao menos uma regra `ACTIVE`). Documento inválido encerra o script com erro, sem criar versão.
2. Cria a versão hospedada com `--version-label <YYYYMMDDHHMMSS UTC>` (rótulo numérico monotônico; é a **revisão**). O validador estrutural do perfil (draft 4) barra aqui, ou no `start-deployment`, quem publicar pelo console fora do script.
3. Inicia o deployment com a estratégia escolhida (padrão `gradual`).
4. Imprime o rótulo (revisão), o número do deployment e o comando de acompanhamento.

**Rollback:** `publish-rules.sh --rollback <revisão>` inicia um novo deployment apontando para a versão com aquele rótulo (padrão `immediate`). Durante um rollout em andamento, `--stop` chama `StopDeployment`.

Permissões necessárias: política `rules-operator` (ver research D-10). A instância não tem essas permissões.

## 3. Leitura pela instância (`AppConfigRuleRepository`)

| Passo | Chamada | Observações |
|-------|---------|-------------|
| Abrir sessão | `StartConfigurationSession(app, env, profile, RequiredMinimumPollIntervalInSeconds=15)` | Na partida e após `BadRequestException` |
| Consultar | `GetLatestConfiguration(token)` | A cada 20 s ± 10%; guardar o `NextPollConfigurationToken` de **cada** resposta |
| Corpo vazio | | Sem mudança; só atualiza `lastSuccessfulRefreshAt` |
| Corpo + `Version-Label` numérico | | Validar e, se válido, trocar o snapshot e registrar a revisão |
| Corpo sem rótulo numérico | | Rejeitar (revisão não rastreável), manter snapshot |
| Erro (rede, 429, 5xx, validação) | | Manter snapshot, `rules_refresh_failures_total++`, repetir no próximo ciclo |

Permissões da instância (prefixo da ação a confirmar na referência do IAM): `appconfig:StartConfigurationSession` e `appconfig:GetLatestConfiguration` no ARN `arn:aws:appconfig:<região>:<conta>:application/<app>/environment/<env>/configuration/<perfil>`.

## 4. Configuração da aplicação (variáveis de ambiente)

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `RULES_SOURCE` | `appconfig` em produção, `file` caso contrário | `file` ou `appconfig` |
| `RULES_CONFIG_PATH` | `config/rules.json` | Só com `file` |
| `APPCONFIG_APPLICATION` / `APPCONFIG_ENVIRONMENT` / `APPCONFIG_PROFILE` | — | Identificadores (obrigatórios com `appconfig`) |
| `RULES_POLL_INTERVAL_MS` | `20000` | Intervalo base entre consultas |
| `RULES_STARTUP_TIMEOUT_MS` | `45000` | Prazo total de tentativas na partida |
| `RULES_METRICS_EMF` | `true` em produção | Liga a emissão EMF |

## 5. Métricas e alarmes

Ver [data-model.md](../data-model.md#métricas-nomes-estáveis). Namespace CloudWatch: `FraudDetector/Rules`.

| Alarme | Condição | Ação |
|--------|----------|------|
| `rules-refresh-stale` | `RulesLastRefreshAgeSeconds` máx. > 90 s por 3 períodos de 1 min | Notifica o tópico `ops` |
| `rules-revision-diverged` | `MAX − MIN` de `RulesActiveRevision` > 0 por 20 min | Notifica o tópico `ops` |
| `rules-alert-rate-anomaly` | `AlertsCreated` fora da banda de anomalia | Notifica `ops` e participa do rollback automático |
| `rules-refresh-failures` | `RulesRefreshFailures` > 0 em 2 de 3 períodos de 1 min | Notifica `ops` e participa do rollback automático (reverte documento rejeitado pelas instâncias) |
| Alarmes de saúde existentes (`dlq_not_empty` de cada DLQ e `transactions_age`) | Já existentes | Participam do rollback automático (monitores do ambiente) |

## 6. Rede

No perfil `full` (sem NAT), a lista `interface_endpoints` de `network.tf` ganha `appconfigdata` (a confirmar com `aws ec2 describe-vpc-endpoint-services`). No perfil `lean`, o NAT cobre o acesso.

## 7. Compatibilidade

- O `ProcessTransactionService` continua chamando `loadActiveSnapshot()` e `currentRevision()` com a mesma assinatura.
- O `rule.v1` não muda. O envelope `RulesDocument v1` é novo e versionado (constituição II).
