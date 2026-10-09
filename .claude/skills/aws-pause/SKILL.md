---
name: aws-pause
description: Pausa o ambiente AWS do fraud-detector para economizar custo - ECS em 0 tasks e RDS parado. Não zera NAT, Redis e storage (use /aws-destroy no lean).
disable-model-invocation: true
---

# /aws-pause

Executa `infra/terraform/scripts/pause.sh`.

1. Verifique credenciais (`aws sts get-caller-identity` com `AWS_PROFILE`).
2. Explique o que será feito e o que **continua cobrando**: NAT Gateway (lean), ElastiCache, storage do RDS/ECR/logs. O RDS parado reinicia sozinho após 7 dias.
3. Peça confirmação e rode `infra/terraform/scripts/pause.sh --yes`.
4. Informe o resultado e sugira `/aws-resume` para voltar, ou `/aws-destroy lean` para zerar o custo.

Não mexe no Terraform; um `terraform apply` manual com o serviço pausado o religa (o `up.sh` já trata o RDS).
