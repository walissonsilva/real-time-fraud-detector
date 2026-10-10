# Quickstart de validação: regras dinâmicas via AppConfig

Guia para provar a feature de ponta a ponta. Detalhes de contrato em [contracts/](contracts/), modelo em [data-model.md](data-model.md).

## 1. Local (sem AWS): fonte por arquivo

Pré-requisitos: `npm run infra:up`, `.env` conforme `.env.example`.

```bash
RULES_SOURCE=file npm run start:dev      # lê config/rules.json como hoje
npm run lint && npm test                  # inclui os testes do AppConfigRuleRepository com cliente falso
npm run contracts:validate                # inclui rules-document.v1
```

Esperado: o serviço sobe com o arquivo; os testes cobrem corpo vazio, troca atômica, documento inválido, token expirado e erro de rede; `contracts:validate` passa com `rules-document.v1`.

## 2. AWS: infraestrutura e semeadura

Pré-requisitos: ambiente `infra/terraform/envs/production` aplicável, imagem publicada no ECR.

```bash
cd infra/terraform/envs/production && terraform apply        # cria aplicação, ambiente, perfil, estratégias, alarmes, IAM e o endpoint appconfigdata (perfil full)
scripts/rules/publish-rules.sh config/rules.json --strategy immediate   # semeia a primeira revisão
# em seguida, subir o serviço ECS
```

Esperado: as tarefas sobem e `/metrics` mostra `rules_active_revision` igual ao rótulo impresso pelo script.

## 3. Cenários de aceitação (mapeados às histórias)

| # | Cenário | Como executar | Resultado esperado |
|---|---------|---------------|--------------------|
| 1 | Alterar regra sem redeploy (H1, SC-001) | Editar o limite de `high-amount` e rodar `publish-rules.sh arquivo.json` | Em até ~10 min de rollout + ≤ 30 s, todas as tarefas mostram a revisão nova; transações acima do novo limite passam a gerar alerta; nenhuma tarefa reiniciou |
| 2 | Troca atômica (H1, SC-007) | Teste de integração: avaliar em laço enquanto o snapshot é trocado | Nenhuma avaliação mistura regras de duas revisões |
| 3 | Rollback manual (H2, SC-002) | `publish-rules.sh --rollback <revisão anterior>` | Todas as tarefas voltam à revisão anterior no mesmo prazo |
| 4 | Rollback automático (H2) | Durante um rollout gradual, forçar um dos alarmes monitorados | O deployment é revertido sozinho; as tarefas voltam à revisão anterior |
| 5a | Documento inválido pelo script (H3, SC-004) | Rodar `publish-rules.sh` com documento fora do contrato, com `ruleId` duplicado, expressão inválida, regra `WINDOWED` ou nenhuma regra `ACTIVE` | O script encerra com erro antes de criar a versão |
| 5b | Documento estruturalmente inválido pelo console (H3, FR-005) | Criar a versão e iniciar o deployment pelo console/CLI, sem o script, com campo obrigatório ausente ou `ruleId` fora do padrão | O validador draft 4 do perfil rejeita; nenhuma tarefa muda de revisão |
| 6a | Documento inválido que chega à instância (H3) | Teste unitário com o cliente falso devolvendo conteúdo inválido | Snapshot mantido, `rules.document.rejected` com `ruleId`, `rules_refresh_failures_total` sobe |
| 6b | Rollback automático por falhas de refresh (H2, H3) | Em ambiente de teste, publicar pelo console um documento que passe no schema mas tenha expressão inválida, com a estratégia gradual | As instâncias rejeitam, `RulesRefreshFailures` sobe, o alarme `rules-refresh-failures` dispara e o deployment é revertido dentro da janela de *bake* |
| 7 | AppConfig indisponível em runtime (H4, SC-003) | Remover a permissão da role ou bloquear o acesso por regra de rede com o tráfego em andamento | Processamento e latência inalterados; `rules_last_refresh_age_seconds` cresce; alarme `rules-refresh-stale` dispara |
| 8 | Partida sem AppConfig (H4, SC-005) | Subir uma tarefa com o acesso bloqueado (por exemplo, no perfil `full` sem o endpoint `appconfigdata`) | A tarefa falha em até ~45 s com `rules.startup.failed`; as antigas seguem atendendo |
| 9 | Defasagem e divergência (H5, SC-006) | Pausar o poll de uma tarefa (ou usar revisão diferente em ambiente de teste) por mais de 20 min | Alarme `rules-revision-diverged` dispara |
| 10 | Fonte por arquivo e padrão de produção (H6) | Subir com `NODE_ENV=production` sem `RULES_SOURCE`; depois com `RULES_SOURCE=file` | O primeiro usa AppConfig e não lê o arquivo; o segundo lê o arquivo |

## 4. Carga

Repetir o teste k6 existente (`npm run load:k6` / `infra/terraform/scripts/loadtest.sh`) com uma publicação de regras no meio da execução. Esperado: latência de alerta ≤ 500 ms (p99) sem degradação perceptível na janela da troca (constituição V).
