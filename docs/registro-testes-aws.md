# Registro de testes na AWS

Registro resumido de **todos os testes executados na AWS** (carga ou simples), com as principais métricas. Cada execução entra numa linha da tabela do seu tipo e, se houver detalhe que importe, numa nota abaixo. Os relatórios completos do k6 ficam em `load/k6/results/` (ignorado pelo git), por isso as métricas relevantes são copiadas para cá.

Procedimentos: [teste de carga 1000 TPS](teste-de-carga-aws-1000tps.md) · [resultado 4.000 TPS](teste-de-carga-aws-4000tps.md) · [resultado 8.000 TPS](teste-de-carga-aws-8000tps.md) · [runner EC2](teste-de-carga-aws-runner-ec2.md) · [quickstart da feature 002](../specs/002-appconfig-dynamic-rules/quickstart.md).

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
| 2026-10-13 05:05 | **Principal 4.000 TPS** (1 instância k6 `c6i.2xlarge` Spot, 6 tasks On-Demand, 1% de alertas) | 4000 TPS, 90 s aquec. + 300 s steady + 60 s drain | ✅ C1–C11, G1 | 1.388.978 / 1.389.000, 0 descartadas | 90 ms / 174 ms (máx. 475 ms) | 207 ms | 13.905 / 13.905, 0 dup. | 49,6% / 15,9% | Primeiro degrau acima da linha de base; gerador a 58% de CPU (máx. 63,7%); 31,6 conexões médias no RDS |
| 2026-10-13 23:21 | Smoke com **lotes de 3** (`SendMessageBatch`) | 51 TPS, 60 s | ✅ | 3.060 / 3.060 | 47 ms / 75 ms | 916,6 ms | 627 / 627, 0 dup. | n/d | Valida o caminho do batch; p99 e2e alto com ~600 alertas (amostra pequena, limiar do smoke é 5 s). Ver A12 |
| 2026-10-13 23:45 | **Principal 3.999 TPS, lotes de 3** (1 instância k6 `c6i.xlarge` Spot, 6 tasks On-Demand, 1% de alertas) | 3999 TPS, 90 s aquec. + 300 s steady + 60 s drain | ✅ C1–C11, G1 | 1.388.691 / 1.388.655, 0 descartadas | 89 ms / 159 ms (máx. 593 ms) | 200 ms | 13.906 / 13.906, 0 dup. | 47,4% / 17,9% | Gerador a 40,6% de CPU (contra 58,3% sem batch); k6 terminou com exit -1 e SSM `Failed` após o resumo completo (ver A12) |
| 2026-10-14 00:33 | **Principal 7.998 TPS, lotes de 3** (1 instância k6 `c6i.2xlarge` Spot, **8 tasks On-Demand = cota cheia**, 1% de alertas) | 7998 TPS, 90 s aquec. + 300 s steady + 60 s drain | ❌ **C6** (C1–C5, C7–C11, G1 ok) | 2.768.331 / 2.768.310, 0 descartadas | 260 ms / **555 ms** (máx. 1.194 ms) | 589 ms | 27.828 / 27.828, 0 dup. | 72,9% / 22,9% | Reprovado por 55 ms no p99; ECS perto do limite, RDS folgado, gerador a 45%; k6 exit 99. Ver [resultado](teste-de-carga-aws-8000tps.md) e A13 |

Critérios de aprovação (C1–C11, G1): envio ≥ 99% sem descartes, erros < 0,1%, alertas recebidos = esperados, 0 duplicados, p95/p99 de serviço < 500 ms, fila `transactions` sem acúmulo, DLQs vazias, CPU ECS < 75%, CPU RDS < 60%, nenhuma task parada, CPU do gerador < 80%.

Relatórios: `load/k6/results/20261011T001125Z-aws-main-25285452*`, `20261011T004007Z-aws-main-0e46e4b5*` e `20261013T050554Z-aws-main-3b8ac3cc*` (4.000 TPS), `20261013T232101Z-aws-smoke-f8ed4414*` (smoke com lotes de 3), `20261013T234554Z-aws-main-45086092*` (3.999 TPS com lotes de 3) e `20261014T003319Z-aws-main-c74e6ca9*` (7.998 TPS com lotes de 3).

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
| 2026-10-13 | `terraform apply` restrito aos alarmes `alert-latency-p99-high` e `outbox-oldest-pending-high` | ✅ | 2 a criar, 0 a alterar, 0 a destruir; ambos em `INSUFFICIENT_DATA` (sem tráfego), assinatura do tópico `ops-alerts` confirmada |
| 2026-10-10 | `terraform apply` completo com a imagem `634e66e-appconfig` | ✅ | 3 a criar, 3 a alterar, 2 a destruir; rolling update das 3 tasks concluído |
| 2026-10-10 | Sondagem do repositório contra o AppConfig real | ✅ | `rules.loaded` revisão 20261010234513, 4 regras, 1 tentativa |
| 2026-10-10 | Logs das 3 tasks após o deploy | ✅ | `rules.loaded` nas 3; alarmes `rules-*` em OK |

## Achados

- **A1: a validação do perfil acontece no `start-deployment`, não na criação da versão.** A versão hospedada inválida é criada, mas nenhum deployment a usa; o AppConfig recusa o `start-deployment`. Remova a versão órfã (`delete-hosted-configuration-version`).
- **A2: `Version-Label` não aceita só dígitos** (padrão `.*[^0-9].*`). O rótulo passou a ser `r` + carimbo UTC; a instância remove o `r`. Corrigido em `publish-rules.sh` e no repositório (2026-10-10).
- **A3: o alarme composto funciona como monitor do ambiente.** Confirmado no cenário 4; o AppConfig reverteu em ~1 s depois que o composto entrou em ALARM.
- **A4: a troca de regras sob carga não degradou a latência** de forma relevante: p99 de serviço de 242 ms contra 122 ms na rodada sem troca, ambos abaixo de 500 ms. Uma execução por cenário; vale repetir para separar a troca da variação do ambiente.
- **A5: cenários 6b, 7 e 9 sem execução na AWS.** O 6b e o 7 criam falha deliberada em produção e foram bloqueados ou deixados para autorização explícita; o 9 depende de espera de 20 min.
- **A6: um `terraform plan` sem `-var image_tag=...` seria destrutivo.** Sem a tag, o plano trocava as task definitions pela tag `none`, removia o alarme `ecs-running-below-desired` e alterava o autoscaling e a policy da aplicação. Use sempre `up.sh` ou informe a tag em execução (`aws ecs describe-task-definition`). Detectado e descartado em 13/10/2026 antes de qualquer apply.
- **A7: o validador do perfil do AppConfig embute `rules-document.v1.draft4.schema.json`.** Qualquer edição nesse arquivo, inclusive só de `description`, aparece como update do perfil em produção. Mudanças de texto devem ficar nos outros schemas.
- **A8: `-target` no dashboard arrasta o RDS.** O dashboard referencia o identificador do banco, então o alvo inclui o `aws_db_parameter_group` (drift de `apply_method` em `rds.force_ssl`, pré-existente). O dashboard ficou pendente e é aplicado junto com esse ajuste.
- **A9: o RDS escalou melhor do que a extrapolação previa.** Entre 1.000 e 4.000 TPS a CPU do RDS foi de ~8% para 15,9% (a extrapolação linear dizia ~33%) e as conexões ficaram em ~32. A CPU do ECS foi a 49,6% com 6 tasks (~670 TPS por task). Por extrapolação linear (**estimativa, não medição**), 8.000 TPS pediriam ~10 a 12 tasks de 1 vCPU e deixariam o RDS em ~30%, abaixo do critério C10. O limite para o 8k é a **cota de capacidade** (Fargate e EC2 Spot), não um componente saturado.
- **A10: o `loadtest.sh` aplica o plano completo, não só o override.** A rodada de 4.000 TPS aplicou também pendências do Terraform (widget de alarmes do dashboard e `apply_method` do `rds.force_ssl`, drift do provider, sem mudança de valor). O provider AWS não respondeu duas vezes ao carregar e o script repetiu com sucesso.
- **A11: a rajada de 25k não foi executada, e o degrau de 8.000 TPS só foi tentado com 8 tasks.** A cota de Fargate On-Demand continua em 8 vCPU (pedido de 16 aberto desde 10/10/2026) e a de EC2 Spot em 8 vCPU. Sem shards do k6 (fase 2 do runner EC2), a 4.000 TPS o gerador usava 58% de uma instância de 8 vCPU; com lotes de 3 (A12) esse limite deixou de ser o gargalo. A tentativa de 8.000 TPS está em A13.
- **A12: o envio em lotes de 3 reduz a CPU do gerador sem alterar a latência da aplicação.** Em 3.999 TPS a CPU do gerador foi de 40,6% numa `c6i.xlarge` (4 vCPU), contra 58,3% numa `c6i.2xlarge` (8 vCPU) a 4.000 TPS com envio individual; a latência de serviço ficou equivalente (p99 de 159 ms contra 174 ms). A 7.998 TPS uma `c6i.2xlarge` ficou em 45,1%, então uma instância basta e a cota de Spot (8 vCPU) deixou de limitar o degrau. O `SendMessageBatch` responde 200 mesmo com entradas rejeitadas; o k6 conta o sucesso por entrada (`Failed[]`). `send_latency_ms` passou a ser por lote e não é comparável com as rodadas anteriores. O efeito do lote sobre a cauda de latência a ~8k TPS não foi isolado. No run de 3.999 TPS o `loadtest.sh` registrou `k6 exit -1` e SSM `Failed` ("instância interrompida?") depois de o resumo completo ter sido emitido; a causa não foi apurada.
- **A13: 7.998 TPS com 8 tasks reprovou em C6 por 55 ms, com o ECS como componente mais carregado.** p95 de serviço de 260 ms (ok) e p99 de 555 ms (limite de 500 ms). A CPU do ECS foi a 72,9% (limite de 75%), a do RDS a 22,9% e a do gerador a 45,1%; 0 perdas, 0 duplicados e DLQs vazias. A leitura é de que a capacidade de 8 vCPU de Fargate é o limite do degrau, **a partir das métricas e sem perfil por componente**. Uma execução só, sem repetição e sem comparação com envio individual. A repetição com ~10 a 12 tasks depende da ampliação da cota. Estimativa linear (**não medida**): 12 tasks levariam a CPU do ECS a ~49%. Detalhes em [teste-de-carga-aws-8000tps.md](teste-de-carga-aws-8000tps.md).
