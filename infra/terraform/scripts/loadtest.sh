#!/usr/bin/env bash
# Teste de carga k6 na AWS (docs/teste-de-carga-aws-1000tps.md): publica a imagem do k6, aplica o override
# On-Demand (loadtest.tfvars), cria a fila-sink assinada no tópico, roda o smoke e a execução principal em
# tasks Fargate, grava o resumo/HTML localmente, coleta o CloudWatch, avalia C1-C11 e reverte o override.
#
# Uso: loadtest.sh <lean|full> [--rate 1000] [--duration 600] [--warmup 180] [--drain 120] [--alert-rate 0.01]
#                  [--cpu 2048 --memory 4096] [--skip-smoke] [--keep] [--pause] [--purge] [--yes]
#   --keep   não reverte o override On-Demand ao final (para repetir sem reaplicar)
#   --pause  chama pause.sh ao final (ECS=0, RDS parado)
#   --purge  esvazia transactions e DLQs se houver resíduos (por padrão aborta)
# Pré-requisito: ambiente de pé (aws-up/aws-resume). Gera custo.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROFILE="${1:-}"; shift || true
RATE=1000; DURATION=600; WARMUP=180; DRAIN=120; ALERT_RATE=0.01; CPU=2048; MEMORY=4096
SKIP_SMOKE=0; KEEP=0; PAUSE=0; PURGE=0; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rate) RATE="${2:?}"; shift ;;
    --duration) DURATION="${2:?}"; shift ;;
    --warmup) WARMUP="${2:?}"; shift ;;
    --drain) DRAIN="${2:?}"; shift ;;
    --alert-rate) ALERT_RATE="${2:?}"; shift ;;
    --cpu) CPU="${2:?}"; shift ;;
    --memory) MEMORY="${2:?}"; shift ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --keep) KEEP=1 ;;
    --pause) PAUSE=1 ;;
    --purge) PURGE=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) die "argumento desconhecido: $1" ;;
  esac; shift
done
require_profile "$PROFILE"
check_aws
command -v docker >/dev/null || die "docker não encontrado"
command -v python3 >/dev/null || die "python3 não encontrado"

VARFILE="$TF_DIR/$PROFILE.tfvars"
LTFILE="$TF_DIR/loadtest.tfvars"
K6_DIR="$REPO_ROOT/load/k6"
RESULTS_DIR="$K6_DIR/results"
SINK_NAME="alerts-loadtest.fifo"
LT_FAMILY="$NAME-loadtest"
LT_LOG_GROUP="/ecs/$NAME-loadtest"
tf_init

# --- pré-condições --------------------------------------------------------------------------------
[ "$(db_status)" = available ] || die "RDS não está disponível; rode aws-resume ou aws-up antes"
DESIRED="$(service_desired || true)"
{ [ -n "$DESIRED" ] && [ "$DESIRED" != 0 ]; } || die "serviço ECS parado (desired=0); rode aws-resume ou aws-up antes"

# Tag da imagem do app em execução (o apply não pode trocá-la nem zerar o serviço)
TASKDEF="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)"
APP_TAG="$(aws ecs describe-task-definition --task-definition "$TASKDEF" --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*://')"
[ -n "$APP_TAG" ] && [ "$APP_TAG" != none ] || die "não foi possível descobrir a tag da imagem do app"

K6_TAG="k6-$(cd "$K6_DIR" && tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 -cf - Dockerfile fraud-latency.js vendor | sha256sum | cut -c1-12)"
STEADY_MIN=$(( DURATION / 60 ))
TOTAL_S=$(( WARMUP + DURATION + DRAIN ))
log "perfil=$PROFILE app=$APP_TAG k6=$K6_TAG | ${RATE} TPS: aquecimento ${WARMUP}s + steady ${DURATION}s (${STEADY_MIN} min) + drain ${DRAIN}s | alertas ${ALERT_RATE}"
log "k6: ${CPU} CPU / ${MEMORY} MiB, envio individual (1 SendMessage por evento)"
confirm "Rodar o teste de carga na AWS? Aplica o override On-Demand (tasks do serviço substituídas) e gera custo."

TF_VARS=(-var-file="$VARFILE" -var-file="$LTFILE" -var "image_tag=$APP_TAG" -var "loadtest_image_tag=$K6_TAG" -var "loadtest_cpu=$CPU" -var "loadtest_memory=$MEMORY")
TASK=""; SINK_URL=""; SUB_ARN=""; REVERTED=0

revert_override() {
  [ "$REVERTED" = 1 ] && return 0
  REVERTED=1
  if [ "$KEEP" = 1 ]; then log "--keep: override On-Demand mantido (reverta com: terraform apply -var-file=$PROFILE.tfvars -var image_tag=$APP_TAG)"; return 0; fi
  log "revertendo o override (volta ao Spot e remove o gerador)"
  tf_apply -input=false -var-file="$VARFILE" -var "image_tag=$APP_TAG" || log "AVISO: reversão falhou; reaplique manualmente"
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" || true
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "$TASK" ]; then aws ecs stop-task --cluster "$CLUSTER" --task "$TASK" --reason "loadtest.sh encerrado" >/dev/null 2>&1 || true; fi
  [ -n "$SUB_ARN" ] && aws sns unsubscribe --subscription-arn "$SUB_ARN" >/dev/null 2>&1 || true
  [ -n "$SINK_URL" ] && aws sqs delete-queue --queue-url "$SINK_URL" >/dev/null 2>&1 || true
  revert_override
  if [ "$PAUSE" = 1 ]; then "$SCRIPTS_DIR/pause.sh" --yes || true; else log "ambiente continua ligado; para parar de gastar: /aws-pause (pause.sh)"; fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

# --- 1) repositório ECR do k6 e imagem -------------------------------------------------------------
tf_apply -target=aws_ecr_repository.loadtest "${TF_VARS[@]}" >/dev/null
REPO="$(tf output -raw loadtest_ecr_repository_url)"
if aws ecr describe-images --repository-name "$LT_FAMILY" --image-ids "imageTag=$K6_TAG" >/dev/null 2>&1; then
  log "imagem $K6_TAG já existe no ECR; pulando build"
else
  DOCKER_CONFIG="$(mktemp -d)"; export DOCKER_CONFIG; echo '{}' >"$DOCKER_CONFIG/config.json"
  aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}" >/dev/null
  ARCH="$(tf console -lock=false -var-file="$VARFILE" <<<'var.cpu_architecture' 2>/dev/null | tail -1 | tr -d '"' || true)"
  PLATFORM="linux/amd64"; [ "$ARCH" = ARM64 ] && PLATFORM="linux/arm64"
  log "build da imagem do k6 ($PLATFORM)"
  docker buildx build --platform "$PLATFORM" -t "$REPO:$K6_TAG" --push "$K6_DIR"
  rm -rf "$DOCKER_CONFIG"; unset DOCKER_CONFIG
fi

# --- 2) override On-Demand + task definition do k6 -------------------------------------------------
tf_apply "${TF_VARS[@]}"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
RUNNING="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].runningCount' --output text)"
log "serviço estável: $RUNNING tasks rodando (On-Demand)"

TOPIC_ARN="$(tf output -raw alerts_topic_arn)"
TOPIC_NAME="$(tf output -raw alerts_topic_name)"
SUBNETS="$(tf output -json private_subnet_ids | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)))')"
SG="$(tf output -raw loadtest_security_group_id)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
SINK_ARN="arn:aws:sqs:$AWS_REGION:$ACCOUNT:$SINK_NAME"

# --- 3) filas limpas -------------------------------------------------------------------------------
queue_url() { aws sqs get-queue-url --queue-name "$1" --query QueueUrl --output text; }
queue_depth() { aws sqs get-queue-attributes --queue-url "$1" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --query 'sum(map(&to_number(@), values(Attributes)))' --output text; }
DLQS=()
while IFS= read -r q; do [ -n "$q" ] && DLQS+=("$q"); done < <(aws sqs list-queues --query 'QueueUrls[]' --output text | tr '\t' '\n' | sed 's|.*/||' | grep -- '-dlq' || true)
for q in transactions "${DLQS[@]}"; do
  url="$(queue_url "$q")"; depth="$(queue_depth "$url")"
  if [ "${depth%.*}" != 0 ]; then
    [ "$PURGE" = 1 ] || die "fila '$q' tem $depth mensagens; use --purge para esvaziar (o resíduo contaminaria a medição)"
    log "esvaziando $q ($depth mensagens)"; aws sqs purge-queue --queue-url "$url" || true
  fi
done

# --- 4) fila-sink FIFO assinada no tópico ----------------------------------------------------------
POLICY="$(python3 - "$SINK_ARN" "$TOPIC_ARN" <<'PY'
import json, sys
arn, topic = sys.argv[1:3]
doc = {"Version": "2012-10-17", "Statement": [
    {"Sid": "AllowAlertsTopic", "Effect": "Allow", "Principal": {"Service": "sns.amazonaws.com"}, "Action": "sqs:SendMessage",
     "Resource": arn, "Condition": {"ArnEquals": {"aws:SourceArn": topic}}},
    {"Sid": "DenyInsecureTransport", "Effect": "Deny", "Principal": "*", "Action": "sqs:*", "Resource": arn,
     "Condition": {"Bool": {"aws:SecureTransport": "false"}}}]}
print(json.dumps({"FifoQueue": "true", "ContentBasedDeduplication": "false", "VisibilityTimeout": "30", "Policy": json.dumps(doc)}))
PY
)"
SINK_URL="$(aws sqs create-queue --queue-name "$SINK_NAME" --attributes "$POLICY" --query QueueUrl --output text)"
aws sqs purge-queue --queue-url "$SINK_URL" 2>/dev/null || true
SUB_ARN="$(aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$SINK_ARN" \
  --attributes RawMessageDelivery=true --return-subscription-arn --query SubscriptionArn --output text)"
log "sink $SINK_NAME assinado em $TOPIC_NAME"

# --- 5) execução de uma task k6 --------------------------------------------------------------------
# run_k6 <rótulo> <rate> <duration> <warmup> <drain> <alert-rate>
# Define RUN_BASE (prefixo dos arquivos), RUN_START/RUN_END (ISO UTC) e RUN_EXIT (exit code do k6).
run_k6() {
  local label="$1" rate="$2" duration="$3" warmup="$4" drain="$5" arate="$6"
  local run_id; run_id="$(date +%s | sha256sum | cut -c1-8)"
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  RUN_BASE="$RESULTS_DIR/${stamp}-aws-${label}-${run_id}"
  mkdir -p "$RESULTS_DIR"
  local env_json
  env_json="$(python3 - "$run_id" "$rate" "$duration" "$warmup" "$drain" "$arate" "$SINK_URL" <<'PY'
import json, sys
run_id, rate, duration, warmup, drain, arate, sink = sys.argv[1:8]
env = {"RUN_ID": run_id, "RATE": rate, "DURATION_SECONDS": duration, "WARMUP_SECONDS": warmup, "DRAIN_SECONDS": drain,
       "ALERT_RATE": arate, "SINK_QUEUE_URL": sink}
print(json.dumps({"containerOverrides": [{"name": "loadtest", "environment": [{"name": k, "value": v} for k, v in env.items()]}]}))
PY
)"
  log "[$label] iniciando task k6 (run $run_id): ${rate} TPS, aquecimento ${warmup}s, steady ${duration}s, drain ${drain}s"
  RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  TASK="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$LT_FAMILY" \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
    --overrides "$env_json" --query 'tasks[0].taskArn' --output text)"
  [ -n "$TASK" ] && [ "$TASK" != None ] || die "falha ao iniciar a task do k6"
  local task_id="${TASK##*/}" status="" limit=$(( (warmup + duration + drain) / 10 + 90 )) i
  for i in $(seq 1 "$limit"); do
    status="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].lastStatus' --output text)"
    [ "$status" = STOPPED ] && break
    sleep 10
  done
  [ "$status" = STOPPED ] || die "a task do k6 não terminou no tempo esperado ($status)"
  RUN_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  RUN_EXIT="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)"
  local reason; reason="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].stoppedReason' --output text)"
  TASK=""
  log "[$label] task terminou (exit $RUN_EXIT; $reason)"
  fetch_artifacts "$task_id" "$run_id" "$RUN_BASE"
}

# Remonta os arquivos K6ART|nome|i|n|base64 dos logs da task: <base>.txt/.json/.html
fetch_artifacts() { # <task_id> <run_id> <base>
  local task_id="$1" run_id="$2" base="$3" stream="loadtest/loadtest/$1" tries lines
  local tmp; tmp="$(mktemp)"
  for tries in 1 2 3 4 5 6; do
    aws logs filter-log-events --log-group-name "$LT_LOG_GROUP" --log-stream-names "$stream" --filter-pattern '"K6ART"' \
      --query 'events[].message' --output text | tr '\t' '\n' | grep '^K6ART|' >"$tmp" || true
    grep -q "^K6ART|$run_id.html|" "$tmp" && break
    log "aguardando os logs do CloudWatch ($tries/6)"; sleep 10
  done
  local ext
  for ext in txt json html; do
    if grep -q "^K6ART|$run_id.$ext|" "$tmp"; then
      grep "^K6ART|$run_id.$ext|" "$tmp" | sort -t'|' -k3,3n -u | cut -d'|' -f5 | tr -d '\n' | base64 -d >"$base.$ext"
    else
      log "AVISO: arquivo .$ext não encontrado nos logs (stream $stream)"
    fi
  done
  rm -f "$tmp"
  [ -f "$base.txt" ] && sed -n '/=== Resumo do teste de carga/,$p' "$base.txt"
  log "resultados: $base.{txt,json,html}"
}

PASSED=1
if [ "$SKIP_SMOKE" = 0 ]; then
  run_k6 smoke 50 60 0 30 0.2
  if [ "$RUN_EXIT" != 0 ]; then
    PASSED=0; log "smoke FALHOU (exit $RUN_EXIT): corrija permissões/assinatura/sink antes de subir a carga"
  fi
fi

if [ "$PASSED" = 1 ]; then
  run_k6 main "$RATE" "$DURATION" "$WARMUP" "$DRAIN" "$ALERT_RATE"
  MAIN_EXIT="$RUN_EXIT"
  [ -f "$RUN_BASE.json" ] || die "sem resumo JSON do k6; veja os logs em $LT_LOG_GROUP"
  log "aguardando 3 min para as métricas do CloudWatch chegarem"; sleep 180
  DLQ_ARGS=(); for q in "${DLQS[@]}"; do DLQ_ARGS+=(--dlq "$q"); done
  python3 "$SCRIPTS_DIR/loadtest_report.py" --summary "$RUN_BASE.json" --start "$RUN_START" --end "$RUN_END" \
    --rate "$RATE" --duration "$DURATION" --warmup "$WARMUP" --cluster "$CLUSTER" --service "$SERVICE" --db "$DB_ID" \
    --topic "$TOPIC_NAME" --desired "$DESIRED" "${DLQ_ARGS[@]}" \
    --meta "Perfil: $PROFILE | app: $APP_TAG | k6: $K6_TAG ($CPU CPU/$MEMORY MiB) | tasks ECS: $RUNNING" \
    --out "$RUN_BASE-avaliacao.md" || PASSED=0
  log "avaliação: $RUN_BASE-avaliacao.md (k6 exit $MAIN_EXIT)"
fi

[ "$PASSED" = 1 ] && log "APROVADO" || log "REPROVADO ou inválido: veja a avaliação"
[ "$PASSED" = 1 ]
