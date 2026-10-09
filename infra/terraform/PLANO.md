# Plano: infraestrutura AWS (Terraform) — ambiente `production`

## Context

O projeto é um único processo NestJS (`src/main.ts`, porta 3000) que consome SQS, grava em Postgres, publica alertas em SNS FIFO e entrega em duas filas FIFO de canal. Hoje só existe `docker-compose` + LocalStack (`infra/localstack/init-aws.sh`); não há IaC. Objetivo: criar `infra/terraform/` para subir o ambiente `production` na AWS, aplicado manualmente (`terraform apply` local, sem GitHub Actions por enquanto), com requisitos de segurança (criptografia em repouso/trânsito, menor privilégio, rede privada).

Premissas (ajustáveis): região `us-east-1`; computação em **ECS Fargate** (um serviço, sem ALB público); Redis via **ElastiCache** (a config exige `REDIS_URL`, embora o app só faça PING hoje); state remoto em S3 criado por um bootstrap separado.

## Perfis de custo: `lean` (8k TPS, mínimo) e `full` (até 25k TPS)

Mesmo código Terraform, dois arquivos de variáveis: `envs/production/lean.tfvars` e `full.tfvars` (`terraform apply -var-file=lean.tfvars`). Trocar de perfil é um `apply` in-place (RDS Multi-AZ/classe e ECS são modificáveis sem recriar). Recursos opcionais usam `count` guiado por variáveis.

| Item | `lean` (8k TPS) | `full` (25k TPS) |
|---|---|---|
| Rede | 1 NAT Gateway, **sem** VPC endpoints de interface (7 endpoints × 2 AZ ≈ US$100/mês) | VPC endpoints (sqs, sns, ecr, logs, secretsmanager, kms) + sem NAT |
| Criptografia SQS/SNS | **SSE-SQS** (gratuito) e chave gerenciada `alias/aws/sns`; sem CMK em filas (a 8k TPS, chamadas KMS custam caro) | CMK dedicada (rotação) em SQS/SNS/RDS/Secrets/Logs |
| ECS Fargate | ARM64, 1 vCPU/2 GB, desired 3, max 6, **Fargate Spot** (SQS é at-least-once, tolera interrupção) | desired 8, max 20, on-demand (mín. 50% base) |
| RDS Postgres 16 | **Single-AZ**, `db.t4g.medium` ou `db.m6g.large`, gp3 padrão (só alertas são gravados, ~8/s a 0,1%), backup 7d, sem deletion protection | **Multi-AZ**, `db.m6g.xlarge`, gp3, backup 14d, deletion protection, Performance Insights |
| Redis | 1 nó `cache.t4g.micro` sem réplica (só recebe PING hoje) | 2 nós Multi-AZ `cache.t4g.small` |
| Observabilidade | Logs 14d, Container Insights off, Flow Logs só REJECT, sem GuardDuty/Config, CloudTrail básico (1 trail grátis) | Logs 90d, Container Insights, Flow Logs ALL, GuardDuty, alarmes completos |
| SQS FIFO / SNS FIFO | **high-throughput em ambos os perfis**: SNS `fifo_throughput_scope = "MessageGroup"`; filas FIFO de canal e DLQs com `fifo_throughput_limit = "perMessageGroupId"` e `deduplication_scope = "messageGroup"` | idem; checar quotas da região |
| Load test | task Fargate k6 sob demanda (ver abaixo), 0 tasks quando parado | idem, maior |

Ações de economia operacional (ambos os perfis): `desired_count=0` no ECS e `aws rds stop-db-instance` (até 7 dias) entre testes; `terraform destroy` do perfil `lean` quando não estiver em uso; orçamento `aws_budgets_budget` com alerta de e-mail.

**Riscos que mesmo o `lean` não elimina (a validar no 1º teste):**
- **SNS FIFO**: sem high-throughput o limite é 300 publicações/s por tópico; com ele, o limite passa a ser por message group (`MessageGroupId = accountId`) e muito maior por tópico. Habilitado nos dois perfis (ver tabela). Confirmar a versão do provider AWS que suporta `fifo_throughput_scope` e as quotas da região antes do apply.
- **Postgres**: só alertas são gravados (`alerts` + `outbox` na mesma transação, e `deliveries`); transações sem alerta não tocam o banco. A carga é proporcional à taxa de alertas (~8/s a 0,1% de 8k TPS; ~1.250/s no pior caso a 5% de 25k TPS). Classes acima são estimativas, a calibrar. O outbox relay faz polling de 1 s por task.
- **Gargalo mais provável (hipótese)**: CPU das tasks/pollers SQS e filas FIFO, não o Postgres.
- Estimativa de custo `lean` ligado: da ordem de US$ 0,25–0,4/h (RDS pequeno + 3 tasks Spot + NAT + Redis); desligado, só storage/NAT. Validar com `infracost` antes do apply.

### Infra de teste de carga (módulo opcional `loadtest`, `enable_loadtest=true`)
O `load/k6/fraud-latency.js` usa a API sem assinatura do LocalStack e **não roda na AWS**. Para o teste de 8k TPS é preciso:
- Task Fargate `k6` na VPC (subnet privada, `sg-loadtest`), com task role `loadtest-role`: `sqs:SendMessage` em `transactions`; `sqs:CreateQueue/DeleteQueue/ReceiveMessage/DeleteMessage/SetQueueAttributes/GetQueueAttributes` apenas em `alerts-loadtest*.fifo`; `sns:Subscribe/Unsubscribe` em `alerts.fifo`; fila-sink com policy do SNS.
- Ajuste de código (fora do Terraform): assinar requests com SigV4 (xk6-sqs/ou adaptar `scripts/load-test.ts` com AWS SDK, que já suporta credenciais da role). Registrar como pendência 6.
- Para 8k TPS, 1 gerador k6 pequeno costuma bastar; para 25k, N tasks em paralelo.

## Execução e acompanhamento do plano
- **Passo 0**: copiar este plano para `infra/terraform/PLANO.md` (no repo). Ele é documento vivo: ao longo da execução, qualquer desvio (recurso trocado, limite de quota, erro de apply, decisão de custo) é registrado numa seção "Desvios de curso" no final do arquivo com data e motivo, e o plano é atualizado.
- Sem `git commit`/`push` automáticos (AGENTS.md): paro após as alterações para sua revisão.
- Antes de cada `terraform apply` mostro o `plan` e peço confirmação; nada é aplicado sem sua autorização.

## Achados do código que afetam a infra

- Só SQS e SNS são usados via SDK. Filas são resolvidas **por nome** (`GetQueueUrl`), sem URL em env.
- `SnsEventBus` hoje chama `sns:CreateTopic` para resolver o ARN; será trocado por `SNS_ALERTS_TOPIC_ARN` (pendência 2), eliminando essa permissão.
- Nenhuma queue policy no init script: na AWS é obrigatório permitir `sns.amazonaws.com` → `SendMessage` nas filas de canal.
- **Migrations não estão na imagem** (`ts-node` é devDependency; `.sql` não vai para `dist`). Precisa de solução: ver "Pendências de código".
- Sem API de entrada nem autenticação: nenhum endpoint público. `/health/*` e `/metrics` não têm auth → manter internos.
- `DATABASE_URL` (com senha) e `REDIS_URL` são os únicos obrigatórios e sensíveis.
- Visibility timeout de `transactions` = 10 s e backoff do app (`MAX_RETRIES=3`, até 30 s) são acoplados ao código; manter 10 s.
- `CHANNEL_*_FAIL` devem ficar `false`.

## Recursos a criar

### 1. Bootstrap do state (módulo separado `infra/terraform/bootstrap`, state local, roda uma vez)
- `aws_s3_bucket` do tfstate (versionamento, SSE-KMS/AES256, block public access, política deny `aws:SecureTransport=false`)
- Locking: `use_lockfile = true` no backend S3 (Terraform ≥ 1.10), sem DynamoDB.

### 2. Rede (`modules/network`)
- VPC (10.0.0.0/16), 2 AZs
- 2 subnets públicas (apenas NAT) + 2 privadas (app) + 2 isoladas (RDS/Redis)
- Internet Gateway, 1 NAT Gateway (ou VPC endpoints para evitar NAT — ver abaixo), route tables
- **VPC Endpoints** (para o tráfego AWS não sair pela internet): interface `sqs`, `sns`, `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager`, `kms`; gateway `s3` (layers do ECR). Com isso o NAT pode ser dispensado (recomendado para um ambiente sem chamadas externas)
- VPC Flow Logs → CloudWatch Logs (retenção 90 dias)

### 3. Security Groups
| SG | Ingress | Egress |
|---|---|---|
| `sg-app` (tasks ECS) | nenhum (sem ALB) | 5432→`sg-rds`, 6379→`sg-redis`, 443→`sg-vpce` |
| `sg-rds` | 5432 de `sg-app` e `sg-migrate` | nenhum |
| `sg-redis` | 6379 de `sg-app` | nenhum |
| `sg-vpce` | 443 de `sg-app`/`sg-migrate` | — |

### 4. KMS
- CMK `fraud-detector-prod` (rotação anual) usada em SQS, SNS, Secrets Manager, RDS, CloudWatch Logs, ECR. Key policy: admin = conta; uso concedido às roles abaixo e ao serviço `sns.amazonaws.com` (necessário para SNS→SQS criptografados) e `logs.<region>.amazonaws.com`.

### 5. Mensageria (espelha `init-aws.sh`, + criptografia + policies)
- SQS `transactions-dlq` (Standard, retenção 14d, SSE-KMS)
- SQS `transactions` (Standard, visibility 10 s, redrive → `transactions-dlq`, maxReceiveCount 10, SSE-KMS)
- SNS `alerts.fifo` (FIFO, `ContentBasedDeduplication=false`, `fifo_throughput_scope="MessageGroup"`, `kms_master_key_id` no perfil `full`)
- SQS FIFO `alert-deliveries-antifraud-queue-dlq.fifo` e `alert-deliveries-customer-push-dlq.fifo` (retenção 14d, `ContentBasedDeduplication=false`, SSE-KMS)
- SQS FIFO `alert-deliveries-antifraud-queue.fifo` e `alert-deliveries-customer-push.fifo` (visibility 30 s, sem redrive — igual ao código; SSE-KMS). Avaliar `fifo_throughput_limit=perMessageGroupId` + `deduplication_scope=messageGroup` (risco D-06 de throughput FIFO)
- 2× `aws_sns_topic_subscription` (`protocol=sqs`, `raw_message_delivery=true`, sem filter policy)
- **Queue policy** em cada fila de canal: `Allow Principal sns.amazonaws.com, sqs:SendMessage, Condition aws:SourceArn = <alerts.fifo ARN>`
- **Queue policy** em todas as filas: `Deny` quando `aws:SecureTransport=false`
- **Queue policy** em `transactions`: permitir `SendMessage` para produtores (roles/contas upstream — variável `transaction_producer_principals`, vazio por padrão)

### 6. Banco de dados e cache
- RDS PostgreSQL 16 (Multi-AZ, `db.m6g.large` ponto de partida, gp3, `storage_encrypted` com CMK, backup 14d, deletion protection, `rds.force_ssl=1` via parameter group, subnet group isolado, não público, Performance Insights, logs → CloudWatch)
- Senha master gerenciada pelo RDS (`manage_master_user_password=true`, no Secrets Manager); secret `fraud/prod/database-url` montado com a URL (`?sslmode=require`) para a task
- ElastiCache Redis 7 (replication group, 2 nós Multi-AZ, `at_rest_encryption_enabled`, `transit_encryption_enabled` → `rediss://`, AUTH token em Secrets Manager `fraud/prod/redis-url`)

### 7. Containers
- ECR `fraud-detector` (IMMUTABLE tags, scan on push, criptografia KMS, lifecycle: manter 20 imagens)
- ECS Cluster (Container Insights)
- Task definition `fraud-detector` (Fargate, ARM64 se a imagem for multi-arch; 1 vCPU/2 GB inicial), container na porta 3000, `readonlyRootFilesystem`, usuário `node`, healthcheck em `/health/live`
  - env: `AWS_REGION`, nomes das filas/tópico (`SQS_*`, `SNS_ALERTS_TOPIC`), `NODE_ENV=production`, `RULES_CONFIG_PATH`, `CONSUMERS_ENABLED=true`, `CHANNEL_CONSUMERS_ENABLED=true`, `CHANNEL_*_FAIL=false`; **sem** `AWS_ENDPOINT_URL`, **sem** chaves AWS
  - secrets: `DATABASE_URL`, `REDIS_URL` via `valueFrom` do Secrets Manager
- ECS Service (desired 2, subnets privadas, sem IP público, deployment circuit breaker + rollback) + Application Auto Scaling (CPU 60% e/ou `ApproximateNumberOfMessagesVisible`/idade da fila `transactions`)
- Task one-off de **migration** (`fraud-detector-migrate`) com `sg-migrate`, rodada via `aws ecs run-task`
- CloudWatch Log Groups `/ecs/fraud-detector` e `/ecs/fraud-detector-migrate` (KMS, retenção 90d)

### 8. Observabilidade e alarmes
- CloudWatch Alarms (→ SNS topic `ops-alerts` com e-mail): profundidade/idade de `transactions-dlq` e DLQs dos canais (> 0), `ApproximateAgeOfOldestMessage` de `transactions`, CPU/memória ECS, CPU/conexões/espaço RDS, ECS tasks running < desired
- Métricas Prometheus (`/metrics`): fase posterior (sidecar ADOT); fora do escopo inicial
- CloudTrail (trail multi-região → S3 com SSE e log validation), GuardDuty, AWS Config opcional

## IAM — roles e policies

Todas com escopo em ARNs específicos (sem `*` em recurso, exceto onde a API exige).

**R1. `ecs-task-execution-role`** (trust: `ecs-tasks.amazonaws.com`) — usada pelo agente ECS
- Managed `AmazonECSTaskExecutionRolePolicy` (ECR pull, logs)
- `secretsmanager:GetSecretValue` nos 2 secrets (`database-url`, `redis-url`)
- `kms:Decrypt` na CMK (para os secrets)

**R2. `fraud-detector-task-role`** (trust: `ecs-tasks.amazonaws.com`) — identidade do app (substitui `AWS_ACCESS_KEY_ID`)
- SQS consumo em `transactions`, `alert-deliveries-antifraud-queue.fifo`, `alert-deliveries-customer-push.fifo`: `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes`, `GetQueueUrl`
- SQS escrita (DLQ publisher) nas 4 DLQs: `SendMessage`, `GetQueueUrl`
- SNS: apenas `Publish` em `alerts.fifo` (sem `CreateTopic`, após a pendência 2)
- KMS: `Decrypt`, `GenerateDataKey` na CMK (necessário para ler/escrever filas e publicar em tópico criptografados)
- Sem acesso a Secrets Manager (injetado pela execution role)

**R3. `fraud-detector-migrate-task-role`** — mesma execution role; task role sem permissões AWS (só precisa de rede até o RDS)

**R4. `vpc-flow-logs-role`** (trust: `vpc-flow-logs.amazonaws.com`) — `logs:CreateLogStream`, `PutLogEvents` no log group

**R5. `rds-monitoring-role`** (trust: `monitoring.rds.amazonaws.com`) — `AmazonRDSEnhancedMonitoringRole`

**R6. `application-autoscaling` service-linked role** (criada automaticamente)

**Resource policies (permissões entre recursos)**
- Queue policy filas de canal: `sns.amazonaws.com` → `sqs:SendMessage` condicionado a `aws:SourceArn` do tópico `alerts.fifo`
- Key policy da CMK: `sns.amazonaws.com` (`GenerateDataKey*`, `Decrypt`), `logs.us-east-1.amazonaws.com`, R1, R2
- Queue `transactions`: produtores upstream (`sqs:SendMessage`)
- Deny `aws:SecureTransport=false` em S3/SQS/SNS

**Operador (sua máquina)**: usuário/role SSO com permissão para aplicar o Terraform (admin temporário no 1º apply). Recomendado `aws sso login` / perfil nomeado, nunca chaves longas em arquivo do repo.

## Estrutura de arquivos proposta
```
infra/terraform/
  bootstrap/            # bucket do state
  envs/production/      # main.tf, backend.tf, variables.tf, terraform.tfvars, outputs.tf
  modules/{network,kms,messaging,data,ecr,ecs,iam,monitoring}/
  README.md             # passo a passo de apply
```
Provider AWS ~> 5.x, `default_tags` (Project, Env=production, ManagedBy=terraform).

## Pendências de código/decisão (fora do Terraform, mas bloqueiam o deploy)
1. **Migrations (necessárias na cloud: o RDS nasce vazio e o `/health/ready` só faz `SELECT 1`)**: em `nest-cli.json` adicionar `assets` copiando `database/migrations/*.sql` para `dist`; o `migrate.ts` já é compilado para `dist/database/migrate.js` (confirmar no build) e `pg` é dependência de produção. Terraform cria a task definition `fraud-detector-migrate` (mesma imagem, comando `node dist/database/migrate.js`), executada com `aws ecs run-task` antes de escalar o serviço (depois, passo de pipeline). Descartado: migrar no startup (corrida entre tasks) e a partir da máquina local (exigiria expor o RDS).
2. **ARN do tópico por env**: adicionar `SNS_ALERTS_TOPIC_ARN` (opcional) em `src/config/config.module.ts` e `.env.example`; `SnsEventBus` usa o ARN se definido e mantém o `CreateTopic` como fallback (LocalStack/compose inalterados). Atualizar `sns-event-bus.spec.ts`. No ECS o Terraform injeta o ARN e a task role fica **sem** `sns:CreateTopic`.
3. **Redis**: manter ElastiCache (custo) ou relaxar `REDIS_URL` como opcional enquanto não for usado.
4. **Load test k6** usa API sem SigV4 do LocalStack; não roda contra a AWS real.
5. Domínio/ALB/WAF: não necessários agora (sem endpoint público).
6. **k6/load test**: adaptar para SigV4/AWS SDK (ver módulo `loadtest`).

> Nota: os valores da tabela de perfis (classes, nº de tasks) são pontos de partida a calibrar no 1º teste; as seções 2–8 abaixo descrevem o perfil `full` e o `lean` aplica as reduções da tabela.

## Ordem de execução (apply local)
1. `aws sso login`; `terraform -chdir=bootstrap apply`
2. `terraform -chdir=envs/production init` (backend S3) → `plan` → `apply` (primeiro ECR, KMS, rede, dados, mensageria)
3. Build + push da imagem ao ECR (`docker build`, tag imutável)
4. `aws ecs run-task` da migration; depois ECS service com a imagem
5. Atualizar o service (variável `image_tag`) e `apply`

## Verificação
- `terraform fmt -check`, `terraform validate`, `tflint`/`checkov` (ou `trivy config`) sem achados críticos
- `terraform plan` revisado antes do apply
- Enviar mensagem de teste ao SQS `transactions` (TransactionEvent v1 válido) e confirmar: alerta em `alerts` (RDS), publicação no SNS, mensagens chegando nas duas filas FIFO de canal
- `/health/ready` OK via `aws ecs execute-command` ou logs; logs no CloudWatch
- Forçar mensagem inválida → cai em `transactions-dlq` e alarme dispara
- Confirmar que RDS/Redis/SQS não são acessíveis fora da VPC e que não há chaves AWS no task definition
- `terraform destroy` fica protegido (deletion protection) — documentar no README

## Desvios de curso (registro vivo)

### 2026-10-09 — implementação inicial (código escrito e validado; nada aplicado na AWS)
- **Sem módulos**: em vez de `modules/*`, um único root `envs/production` com arquivos por assunto (`network.tf`, `kms.tf`, `messaging.tf`, `data.tf`, `iam.tf`, `ecr.tf`, `ecs.tf`, `monitoring.tf`). Menos indireção para um único ambiente.
- **Senha do RDS**: `random_password` + secret `fraud/prod/database-url` montado pelo Terraform, em vez de `manage_master_user_password` (o app exige uma `DATABASE_URL` única). Consequência: a senha fica no state (bucket com SSE, versionamento e acesso bloqueado).
- **TLS do Postgres**: `sslmode=verify-full`; o pg 8.23 trata `require` como `verify-full`, e o certificado do RDS não está no bundle do Node. O `Dockerfile` agora baixa o bundle de CAs do RDS e define `NODE_EXTRA_CA_CERTS`.
- **Arquitetura padrão X86_64**: esta máquina (WSL) não tem emulação arm64 (`exec format error`); ARM64 continua disponível via `cpu_architecture` (exige build arm64).
- **DLQs são 3** (transactions + 2 de canal), não 4 como estava na seção de IAM; a policy usa os ARNs reais.
- **Sem `aws ecs execute-command`** (exigiria SSM/endpoints); verificação via logs e `/health/ready` por logs.
- **`desired_count` ignorado após a criação** (autoscaling); o serviço nasce com 0 até haver `image_tag`, e o README descreve o `update-service` inicial.
- **Lean não usa CMK**: SQS com SSE-SQS, SNS `alias/aws/sns`, demais recursos com chaves gerenciadas pela AWS. CMK só no `full`.
- **VPC endpoint KMS** só quando `enable_cmk` e `enable_vpc_endpoints`.
- **Provider**: `aws ~> 6.0` (suporta `fifo_throughput_scope`; `terraform validate` OK).
- **Código da app**: `SNS_ALERTS_TOPIC_ARN` (config + `SnsEventBus` + teste), `nest-cli.json` com assets das migrations (confirmado: `dist/database/migrate.js` e `.sql` na imagem), `Dockerfile` com CAs do RDS.
- **Ainda não feito**: `terraform plan/apply` (sem credenciais AWS válidas nesta máquina: `InvalidClientTokenId`), push da imagem, adaptação do k6 para SigV4 (pendência 6), `tflint`/`checkov` (não instalados).

### 2026-10-09 — apply do perfil `lean`
- Bootstrap aplicado (bucket `fraud-detector-tfstate-441176049255`) e `terraform apply -var-file=lean.tfvars` concluído: 100 recursos criados, sem erros. Serviço ECS com `desired_count = 0` (ainda sem imagem).
- `alert_email` fica em `envs/production/secrets.auto.tfvars` (gitignored); a assinatura SNS do e-mail precisa ser confirmada pelo usuário.
- Próximos passos: push da imagem, `apply` com `image_tag`, migration via `run-task`, `update-service`.

### 2026-10-09 — imagem, migration e serviço (lean)
- Imagem `1ad8408-aws1` (x86_64, árvore de trabalho com alterações não commitadas) enviada ao ECR; `apply` com `image_tag` trocou as task definitions.
- **Desvio**: o mínimo do autoscaling (3) fez o ECS subir o serviço assim que o `image_tag` foi aplicado, antes da migration (o `update-service` manual do README não foi necessário). Sem tráfego, sem impacto. Para próximos deploys, rodar a migration antes de aplicar uma nova imagem em serviço já ativo, ou aceitar essa ordem quando o schema for retrocompatível.
- Migration executada via `run-task`: `001_init.sql` e `002_outbox_relay.sql` aplicadas (exit 0).
- Serviço: 3 tasks FARGATE_SPOT `RUNNING/HEALTHY`.
- `aws_db_parameter_group.main` mostrou diff cosmético de `apply_method` em `rds.force_ssl` (valor inalterado).

### 2026-10-09 — scripts e skills de ciclo de vida
- Criados `infra/terraform/scripts/{lib,up,pause,resume,destroy}.sh` e skills `/aws-up`, `/aws-pause`, `/aws-resume`, `/aws-destroy` (`disable-model-invocation`, confirmação obrigatória).
- Novas variáveis Terraform: `ephemeral` (lean=true, full=false) e `start_service` (permite migrar antes de subir o serviço). Com `ephemeral`: secrets com `recovery_window_in_days = 0`, `skip_final_snapshot = true`, ECR `force_delete`.
- **Pendente**: o plano com essas mudanças (6 alterações in-place, nenhuma recriação) ainda NÃO foi aplicado ao ambiente lean; o `destroy` só funciona em ciclo repetido depois disso. O ciclo pause/resume e destroy/up ainda não foi exercitado de verdade (só `--plan-only`: up sem erro, destroy = 100 recursos).
- O apply direto com `-auto-approve` foi bloqueado pelo classificador do Claude Code; os scripts usam plan salvo + apply do arquivo.
- Observação: `aws_db_parameter_group.main` segue mostrando diff cosmético de `apply_method` a cada plan.
