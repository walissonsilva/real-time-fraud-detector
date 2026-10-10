# Infra AWS (Terraform) — ambiente `production`

Plano completo e decisões: [`PLANO.md`](./PLANO.md). Execução manual na máquina local (sem pipeline).

Dois perfis, mesmo código: `lean.tfvars` (8k TPS, custo mínimo) e `full.tfvars` (até 25k TPS).

## Pré-requisitos
- Terraform >= 1.10, AWS CLI v2, Docker.
- Credenciais AWS válidas: `aws sso login --profile <perfil>` e `export AWS_PROFILE=<perfil>` (não guarde chaves no repo).
- Crie `envs/production/secrets.auto.tfvars` (gitignored) com `alert_email = "voce@example.com"`.

## 1. Bootstrap do state (uma vez)
```sh
cd infra/terraform/bootstrap
terraform init && terraform apply
```
Copie `envs/production/backend.hcl.example` para `backend.hcl` e troque `<ACCOUNT_ID>` pelo valor de `bucket`.

## 2. Infra base (sem imagem ainda)
```sh
cd infra/terraform/envs/production
terraform init -backend-config=backend.hcl
terraform plan  -var-file=lean.tfvars -out=lean.plan   # revisar
terraform apply lean.plan
```
Sem `image_tag` o serviço ECS é criado com `desired_count = 0`. Confirme a assinatura do e-mail de alarmes/orçamento.

## 3. Imagem
```sh
REPO=$(terraform output -raw ecr_repository_url); TAG=$(git rev-parse --short HEAD)
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build -t "$REPO:$TAG" ../../..      # X86_64; para ARM64 use buildx --platform linux/arm64 e cpu_architecture=ARM64
docker push "$REPO:$TAG"
```

## 4. Migrations (uma vez por versão de schema, antes de subir o serviço)
```sh
terraform apply -var-file=lean.tfvars -var image_tag=$TAG   # registra a imagem nas task definitions
aws ecs run-task --cluster fraud-detector --launch-type FARGATE \
  --task-definition "$(terraform output -raw migrate_task_definition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw migrate_security_group_id)],assignPublicIp=DISABLED}"
# acompanhe em /ecs/fraud-detector-migrate (CloudWatch Logs)
```

## 5. Subir o serviço
O `desired_count` é ignorado após a criação (o autoscaling o gerencia). Depois da migration:
```sh
aws ecs update-service --cluster fraud-detector --service fraud-detector --desired-count 3
```

## Trocar de perfil / economizar
- `terraform apply -var-file=full.tfvars -var image_tag=$TAG` altera in-place (RDS e ECS); troque também a CMK/endpoints — revisar o `plan`.
- Entre testes: `aws ecs update-service ... --desired-count 0` e `aws rds stop-db-instance --db-instance-identifier fraud-detector` (reinicia sozinho após 7 dias).
- `lean` pode ser destruído (`terraform destroy -var-file=lean.tfvars`); `full` tem deletion protection no RDS.

## Teste de carga
O teste de carga k6 na AWS roda com `scripts/loadtest.sh <lean|full>` (skill `/aws-loadtest`): publica a imagem do k6 no ECR (`load/k6/Dockerfile`), aplica `loadtest.tfvars` (serviço On-Demand + `enable_loadtest`), roda o smoke e a execução principal em task Fargate na VPC, grava resumo/HTML em `load/k6/results/`, avalia os critérios e reverte o override. Ver `docs/teste-de-carga-aws-1000tps.md`.

## Scripts e skills de ciclo de vida
Em `scripts/` (lógica versionada; as skills `/aws-up`, `/aws-pause`, `/aws-resume`, `/aws-destroy` em `.claude/skills/` são wrappers que pedem confirmação):

| Script | O que faz |
|---|---|
| `up.sh <lean\|full> [--plan-only] [--yes] [--tag t]` | ECR → build/push → task definitions (serviço parado) → migration → sobe o serviço. Usa plan salvo, nunca `-auto-approve`. |
| `pause.sh [--yes]` | ECS em 0 (e autoscaling mín. 0) + RDS parado. **Não** zera NAT, Redis e storage. |
| `resume.sh <perfil> [--yes]` | Liga o RDS e restaura o autoscaling/desired do perfil. |
| `destroy.sh lean [--plan-only] [--yes]` | Destrói o lean (zera o custo; apaga banco e imagens). Recusa `full`. |

Pré-requisito: `AWS_PROFILE` válido, `envs/production/backend.hcl` e `secrets.auto.tfvars`. O perfil `lean` usa `ephemeral = true` (secrets sem janela de recuperação, sem snapshot final, ECR com `force_delete`) para permitir destroy + recriação.
