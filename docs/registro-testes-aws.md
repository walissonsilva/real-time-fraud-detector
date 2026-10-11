# Registro de testes na AWS

Registro resumido de **todos os testes executados na AWS** (carga ou simples), com as principais métricas. Cada execução entra numa linha da tabela do seu tipo e, se houver detalhe que importe, numa nota abaixo. Os relatórios completos do k6 ficam em `load/k6/results/` (ignorado pelo git), por isso as métricas relevantes são copiadas para cá.

Procedimentos: [teste de carga 1000 TPS](teste-de-carga-aws-1000tps.md) · [runner EC2](teste-de-carga-aws-runner-ec2.md) · [quickstart da feature 002](../specs/002-appconfig-dynamic-rules/quickstart.md).

**Ambiente comum das execuções abaixo:** conta `441176049255`, `us-east-1`, perfil `lean`, 3 tasks ECS (imagem `634e66e-appconfig`), RDS e Redis do perfil lean, AppConfig `96pzq29` (ambiente `ahtfypq`, perfil `1c6w3r2`).

## Como registrar uma nova execução

1. Rode o teste e anote data (UTC), perfil, imagem e o que mudou em relação ao último registro.
2. Acrescente uma linha na tabela de **Testes de carga** ou **Testes simples**, com o resultado (✅ aprovado, ❌ reprovado, ⚠️ parcial, ⏭️ não executado) e as métricas principais.
3. Se reprovou, ficou parcial ou revelou algo inesperado, escreva uma nota curta em **Achados**.
4. Aponte o relatório (`load/k6/results/<arquivo>`) ou o comando usado para reproduzir.

## Testes de carga

| Data (UTC) | Cenário | Carga | Resultado | Envio | Latência serviço p95 / p99 | Latência e2e p99 | Alertas | CPU ECS / RDS | Observações |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-11 00:09 | Smoke 1 | 50 TPS, 60 s | ✅ | 3.000 / 3.000 | 55 ms / 79 ms | 395 ms | 595 / 595 | n/d | Valida o gerador antes da carga |
| 2026-10-11 00:11 | Principal 1 (sem troca de regras) | 1000 TPS, 90 s aquec. + 300 s steady + 60 s drain | ✅ C1–C11, G1 | 354.000 / 354.000 | 92 ms / 122 ms | 149 ms | 3.513 / 3.513, 0 dup. | 21,8% / 8,3% | Linha de base |
| 2026-10-11 00:38 | Smoke 2 | 50 TPS, 60 s | ✅ | 3.000 / 3.000 | 56 ms / 101 ms | 593 ms | 611 / 611 | n/d | |
| 2026-10-11 00:40 | **T053**: principal 2, **com publicação de regras no meio** | 1000 TPS, idem | ✅ C1–C11, G1 | 353.999 / 354.000 | 105 ms / 242 ms | 284 ms | 3.703 / 3.703, 0 dup. | 31,2% / 8,4% | Revisão `r20261011004358` publicada a ~200 s do início (janela steady); 3 instâncias aplicaram em 2–6 s, sem reinício |

Critérios de aprovação (C1–C11, G1): envio ≥ 99% sem descartes, erros < 0,1%, alertas recebidos = esperados, 0 duplicados, p95/p99 de serviço < 500 ms, fila `transactions` sem acúmulo, DLQs vazias, CPU ECS < 75%, CPU RDS < 60%, nenhuma task parada, CPU do gerador < 80%.

Relatórios: `load/k6/results/20261011T001125Z-aws-main-25285452*` e `20261011T004007Z-aws-main-0e46e4b5*`.

## Testes simples

### Feature 002: regras dinâmicas via AppConfig

Cenários de [`quickstart.md` §3](../specs/002-appconfig-dynamic-rules/quickstart.md). Execuções de 2026-10-10 a 2026-10-11.

| # | Cenário | Como foi feito | Resultado | Métrica principal |
|---|---|---|---|---|
| 1 | Alterar regra sem redeploy | `publish-rules.sh` com nova revisão, estratégia imediata | ✅ | 3 instâncias na revisão nova em ≤ 25 s; nenhuma task reiniciada |
| 2 | Troca atômica | Teste de integração `rules-atomic-swap` | ✅ | 0 avaliações com conjunto misto |
| 3 | Rollback manual | `publish-rules.sh --rollback r20261010234513` | ✅ | 3 instâncias de volta à revisão anterior em ~1 min |
| 4 | Rollback automático por alarme | Rollout gradual com revisão válida; `set-alarm-state` forçou `rules-refresh-failures` em ALARM | ✅ | `ROLLBACK_COMPLETED` por `CLOUDWATCH_ALARM` ~1 s após o alarme composto disparar; deployment `ROLLED_BACK` com 0% |
| 5a | Documento inválido barrado pelo script | `publish-rules.sh` com `{"rules":[{"ruleId":"BAD"}]}` | ✅ | Erro antes de criar a versão; nada publicado |
| 5b | Documento estruturalmente inválido pela CLI | `create-hosted-configuration-version` + `start-deployment` sem o script | ✅ | Validador draft 4 recusou o deployment (`missing required properties`, `ruleId` fora do padrão); nenhuma revisão mudou. Ver nota A1 |
| 6a | Inválido que chega à instância | Teste unitário do repositório | ✅ | Snapshot mantido, `rules.document.rejected`, contador de falhas sobe |
| 6b | Rollback automático por falhas de refresh | Publicar expressão inválida em rollout gradual | ⏭️ | Bloqueado pelo classificador de permissões (publica configuração quebrada em produção). Coberto por teste unitário e por 4 |
| 7 | AppConfig indisponível em runtime | Revogar a permissão da role `app` com tráfego | ⏭️ | Não executado na AWS (altera IAM de produção). Coberto por `rules-source-outage` (passa) |
| 8 | Partida sem AppConfig | Instância local com perfil inexistente no AppConfig real | ✅ | `rules.startup.failed` (`NOT_FOUND`) em 45 s, 8 tentativas, processo não sobe |
| 9 | Divergência de revisão por 20 min | Manter uma instância atrasada por mais de 20 min | ⏭️ | Não executado (espera longa e exige instância atrasada). Alarme `rules-revision-diverged` criado e em OK |
| 10 | Padrão de produção / fonte por arquivo | Teste unitário `config.module.spec` | ✅ | `NODE_ENV=production` sem `RULES_SOURCE` usa `appconfig`; `file` lê o arquivo |
| CloudTrail | Auditoria das mudanças | `lookup-events` | ✅ | `CreateHostedConfigurationVersion` e `StartDeployment` registrados com a identidade do operador |

### Infraestrutura

| Data (UTC) | Teste | Resultado | Métrica principal |
|---|---|---|---|
| 2026-10-10 | `terraform plan` restrito (recursos novos do AppConfig) | ✅ | 16 a criar, 0 a alterar, 0 a destruir |
| 2026-10-10 | `terraform apply` completo com a imagem `634e66e-appconfig` | ✅ | 3 a criar, 3 a alterar, 2 a destruir; rolling update das 3 tasks concluído |
| 2026-10-10 | Sondagem do repositório contra o AppConfig real | ✅ | `rules.loaded` revisão 20261010234513, 4 regras, 1 tentativa |
| 2026-10-10 | Logs das 3 tasks após o deploy | ✅ | `rules.loaded` nas 3; alarmes `rules-*` em OK |

## Achados

- **A1: a validação do perfil acontece no `start-deployment`, não na criação da versão.** A versão hospedada inválida é criada, mas nenhum deployment a usa; o AppConfig recusa o `start-deployment`. Remova a versão órfã (`delete-hosted-configuration-version`).
- **A2: `Version-Label` não aceita só dígitos** (padrão `.*[^0-9].*`). O rótulo passou a ser `r` + carimbo UTC; a instância remove o `r`. Corrigido em `publish-rules.sh` e no repositório (2026-10-10).
- **A3: o alarme composto funciona como monitor do ambiente.** Confirmado no cenário 4; o AppConfig reverteu em ~1 s depois que o composto entrou em ALARM.
- **A4: a troca de regras sob carga não degradou a latência** de forma relevante: p99 de serviço de 242 ms contra 122 ms na rodada sem troca, ambos abaixo de 500 ms. Uma execução por cenário; vale repetir para separar a troca da variação do ambiente.
- **A5: cenários 6b, 7 e 9 sem execução na AWS.** O 6b e o 7 criam falha deliberada em produção e foram bloqueados ou deixados para autorização explícita; o 9 depende de espera de 20 min.
