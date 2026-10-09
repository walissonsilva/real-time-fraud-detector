#!/usr/bin/env bash
# Sobe (ou atualiza) o ambiente: infra, imagem, migration e serviço.
# Uso: up.sh <lean|full> [--plan-only] [--yes] [--tag <tag>]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROFILE="${1:-}"; shift || true
PLAN_ONLY=0; ASSUME_YES=0; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan-only) PLAN_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    --tag) TAG="${2:?}"; shift ;;
    *) die "argumento desconhecido: $1" ;;
  esac; shift
done
require_profile "$PROFILE"
check_aws
VARFILE="$TF_DIR/$PROFILE.tfvars"
tf_init
ensure_rds_available

if [ -z "$TAG" ]; then
  TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- . ':!infra')" ] || TAG="$TAG-dirty$(date +%Y%m%d%H%M%S)"
fi
log "perfil=$PROFILE tag=$TAG"

if [ "$PLAN_ONLY" = 1 ]; then
  CUR="$(service_desired || true)"; START=false; { [ -n "$CUR" ] && [ "$CUR" != 0 ]; } && START=true
  tf plan -input=false -var-file="$VARFILE" -var "image_tag=$TAG" -var "start_service=$START"
  exit 0
fi
[ "$PROFILE" = full ] && log "ATENÇÃO: perfil full tem custo alto (RDS Multi-AZ, 8+ tasks, endpoints, GuardDuty)."
confirm "Aplicar o perfil '$PROFILE' (cria/altera recursos e gera custo)?"

TFARGS=(-input=false -var-file="$VARFILE" -var "image_tag=$TAG")

# 1) ECR primeiro (precisamos dele para o push)
tf_apply -target=aws_ecr_repository.app -var-file="$VARFILE" >/dev/null
REPO="$(tf output -raw ecr_repository_url)"

# 2) build + push (config Docker isolada: evita credential helpers quebrados)
if aws ecr describe-images --repository-name "$NAME" --image-ids "imageTag=$TAG" >/dev/null 2>&1; then
  log "imagem $TAG já existe no ECR (tags são imutáveis); pulando build"
else
  DOCKER_CONFIG="$(mktemp -d)"; export DOCKER_CONFIG; echo '{}' >"$DOCKER_CONFIG/config.json"
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}" >/dev/null
  ARCH="$(tf console -var-file="$VARFILE" <<<'var.cpu_architecture' 2>/dev/null | tr -d '"')"
  PLATFORM="linux/amd64"; [ "$ARCH" = ARM64 ] && PLATFORM="linux/arm64"
  log "build $PLATFORM"
  docker buildx build --platform "$PLATFORM" -t "$REPO:$TAG" --push "$REPO_ROOT"
fi

# 3) task definitions com a nova tag. Serviço novo/parado: não sobe ainda (migra antes).
CURRENT="$(service_desired || true)"
if [ -z "$CURRENT" ] || [ "$CURRENT" = 0 ]; then
  tf_apply "${TFARGS[@]}" -var start_service=false
else
  tf_apply "${TFARGS[@]}" -target=aws_ecs_task_definition.migrate
fi

# 4) migration
SUBNETS="$(tf output -json private_subnet_ids | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)))')"
SG="$(tf output -raw migrate_security_group_id)"
log "executando migration"
TASK="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$NAME-migrate" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
EXIT="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)"
[ "$EXIT" = 0 ] || die "migration falhou (exit $EXIT); veja os logs em /ecs/$NAME-migrate"
log "migration ok"

# 5) sobe/atualiza o serviço
tf_apply "${TFARGS[@]}" -var start_service=true
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
log "pronto: $(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[runningCount,desiredCount]' --output text | tr '\t' '/') tasks rodando"
