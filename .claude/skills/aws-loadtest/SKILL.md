---
name: aws-loadtest
description: Roda o teste de carga k6 (1.000 TPS por padrão) contra o ambiente AWS do fraud-detector, em task Fargate na VPC, e avalia os critérios C1-C11. Gera custo e troca as tasks do serviço para On-Demand durante o teste.
disable-model-invocation: true
argument-hint: <lean|full> [--rate N] [--duration S] [--warmup S] [--skip-smoke] [--pause]
---

# /aws-loadtest <lean|full> [opções]

Executa `infra/terraform/scripts/loadtest.sh`, conforme `docs/teste-de-carga-aws-1000tps.md`. Só quando o usuário invocar; **gera custo na AWS**.

1. O perfil deve ser `lean` ou `full`. Se faltar, sugira `lean`.
2. Credenciais: `AWS_PROFILE` válido (`aws sts get-caller-identity`). Se não, peça `! aws sso login --profile <perfil>`.
3. O ambiente precisa estar de pé (RDS disponível, serviço ECS com tasks). Se estiver pausado, sugira `/aws-resume <perfil>` antes.
4. Explique o que vai acontecer: build/push da imagem do k6 no ECR, apply do `loadtest.tfvars` (serviço 100% On-Demand, tasks substituídas), smoke de 50 TPS (1 min) e execução principal (padrão: 1.000 TPS, 3 min de aquecimento + 10 min steady + 2 min de drain), espera de 3 min pelo CloudWatch, avaliação C1-C11 e reversão do override. Duração total ≈ 40 a 60 min.
5. Peça confirmação explícita e só então rode `infra/terraform/scripts/loadtest.sh <perfil> --yes [opções]`. Nunca passe `--yes` sem essa confirmação. Use `--pause` apenas se o usuário pedir para pausar ao final.
6. Resultados em `load/k6/results/<timestamp>-aws-main-<runId>.{txt,json,html}` e `...-avaliacao.md` (ignorados pelo git). Resuma: veredito, critérios que falharam, p95/p99 de serviço, CPU do ECS/RDS e onde procurar o gargalo (seção 8 do documento). Se o veredito for INVÁLIDO, o gerador saturou: repita com `--cpu 4096 --memory 8192`.
7. Se algo falhar, mostre o erro e pare. O script limpa o sink e reverte o override sozinho. Lembre o usuário de `/aws-pause`.

Não faz commit (AGENTS.md).
