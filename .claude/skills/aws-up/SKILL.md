---
name: aws-up
description: Sobe ou atualiza o ambiente AWS (Terraform) do fraud-detector nos perfis lean (8k TPS, mínimo) ou full (até 25k TPS). Faz apply, build/push da imagem, migration e sobe o serviço. Gera custo.
disable-model-invocation: true
argument-hint: <lean|full>
---

# /aws-up <lean|full>

Executa `infra/terraform/scripts/up.sh`. Só quando o usuário invocar; **gera custo na AWS**.

1. O argumento deve ser `lean` ou `full`. Se faltar, pergunte (sugira `lean`).
2. Credenciais: `AWS_PROFILE` precisa estar exportado e válido (`aws sts get-caller-identity`). Se não, peça ao usuário `! aws sso login --profile <perfil>`.
3. Rode `infra/terraform/scripts/up.sh <perfil> --plan-only` e resuma ao usuário: quantos recursos criar/alterar/destruir e qualquer destruição ou recriação (RDS, filas). Para `full`, destaque o custo (RDS Multi-AZ, 8+ tasks, VPC endpoints, GuardDuty).
4. Peça confirmação explícita. Só então rode `infra/terraform/scripts/up.sh <perfil> --yes`. Nunca passe `--yes` sem essa confirmação.
5. Ao final, informe tasks rodando, a tag da imagem e o aviso de custo. Se algo falhar (migration, apply), mostre o erro e pare; não tente contornar.

Se o RDS estiver parado, o script o religa antes do apply. Não faz commit (AGENTS.md).
