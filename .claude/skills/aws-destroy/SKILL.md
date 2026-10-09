---
name: aws-destroy
description: Destrói o ambiente AWS lean do fraud-detector para zerar o custo. Apaga RDS (sem snapshot), Redis, filas, ECR e logs; mantém só o bucket de state. Não destrói o perfil full.
disable-model-invocation: true
argument-hint: lean
---

# /aws-destroy lean

Executa `infra/terraform/scripts/destroy.sh lean`. **Destrutivo e irreversível** - o banco e as imagens são apagados.

1. Aceite apenas `lean`. Para `full`, recuse: o RDS tem deletion protection e destroy não é automatizado; explique e sugira `/aws-pause`.
2. Verifique credenciais (`AWS_PROFILE`).
3. Rode `infra/terraform/scripts/destroy.sh lean --plan-only` e mostre ao usuário o resumo (nº de recursos e os principais: RDS, ElastiCache, NAT, filas, ECR).
4. Peça confirmação **explícita** citando que dados e imagens serão perdidos. Só então rode `infra/terraform/scripts/destroy.sh lean --yes`.
5. Para recriar: `/aws-up lean` (build, migration e serviço de novo; o banco volta vazio).

Não passe `--yes` sem confirmação do usuário na mesma conversa.
