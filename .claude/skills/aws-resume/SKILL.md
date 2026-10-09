---
name: aws-resume
description: Retoma o ambiente AWS do fraud-detector após /aws-pause - liga o RDS e restaura o serviço ECS com os valores do perfil lean ou full.
disable-model-invocation: true
argument-hint: <lean|full>
---

# /aws-resume <lean|full>

Executa `infra/terraform/scripts/resume.sh <perfil>`.

1. O perfil deve ser o mesmo usado no `up` (`lean` ou `full`). Se faltar, pergunte.
2. Verifique credenciais (`AWS_PROFILE`).
3. Avise: o RDS leva alguns minutos para ligar e o ECS volta a gerar custo. Peça confirmação.
4. Rode `infra/terraform/scripts/resume.sh <perfil> --yes` e informe as tasks em execução.

Se o ambiente foi destruído, use `/aws-up` em vez deste.
