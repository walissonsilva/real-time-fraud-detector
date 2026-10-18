#!/usr/bin/env bash
# Teste de carga k6 na AWS (docs/teste-de-carga-aws-1000tps.md e docs/teste-de-carga-aws-runner-ec2.md):
# publica a imagem do k6, aplica o override On-Demand (loadtest.tfvars), cria a fila-sink assinada no tópico,
# roda o smoke e a execução principal (em EC2 Spot por padrão, ou em task Fargate), grava o resumo/HTML
# localmente, coleta o CloudWatch, avalia C1-C11 e reverte o override.
#
# Uso: loadtest.sh <lean|full> [--rate 1000] [--duration 300] [--warmup 90] [--drain 60] [--alert-rate 0.01] [--batch-size 1]
#                  [--runner ec2|fargate] [--instance-type c6i.xlarge] [--on-demand]
#                  [--cpu 2048 --memory 4096] [--skip-smoke] [--smoke-only] [--keep] [--pause] [--purge] [--allow-no-metrics] [--yes]
#   --runner        onde roda o k6: ec2 (padrão; instância Spot via SSM) ou fargate (task; usa --cpu/--memory)
#   --batch-size    eventos por SendMessageBatch (1 = SendMessage individual; máx. 10; --rate deve ser múltiplo)
#   --on-demand     com --runner ec2: instância On-Demand em vez de Spot (fallback sem capacidade Spot)
#   --smoke-only  roda só o smoke (~50 TPS por 60 s) e encerra, sem a carga principal nem a avaliação C1-C11
#   --keep   não reverte o override On-Demand ao final (para repetir sem reaplicar)
#   --pause  chama pause.sh ao final (ECS=0, RDS parado)
#   --purge  esvazia transactions e DLQs se houver resíduos (por padrão aborta)
#   --allow-no-metrics  segue mesmo que a imagem em execução não emita as métricas do dashboard (pipeline.metrics);
#                       sem a flag, --yes aborta nesse caso (rode aws-up antes) e o modo interativo pergunta
# Pré-requisito: ambiente de pé (aws-up/aws-resume). Gera custo.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROFILE="${1:-}"; shift || true
BATCH_SIZE=1; RATE=1000; DURATION=300; WARMUP=90; DRAIN=60; ALERT_RATE=0.01; CPU=2048; MEMORY=4096
SKIP_SMOKE=0; SMOKE_ONLY=0; KEEP=0; PAUSE=0; PURGE=0; ASSUME_YES=0; ALLOW_NO_METRICS=0
RUNNER=ec2; USE_SPOT=true; INSTANCE_TYPE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rate) RATE="${2:?}"; shift ;;
    --duration) DURATION="${2:?}"; shift ;;
    --warmup) WARMUP="${2:?}"; shift ;;
    --drain) DRAIN="${2:?}"; shift ;;
    --alert-rate) ALERT_RATE="${2:?}"; shift ;;
    --batch-size) BATCH_SIZE="${2:?}"; shift ;;
    --cpu) CPU="${2:?}"; shift ;;
    --memory) MEMORY="${2:?}"; shift ;;
    --runner) RUNNER="${2:?}"; shift ;;
    --instance-type) INSTANCE_TYPE="${2:?}"; shift ;;
    --on-demand) USE_SPOT=false ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --smoke-only) SMOKE_ONLY=1 ;;
    --keep) KEEP=1 ;;
    --pause) PAUSE=1 ;;
    --purge) PURGE=1 ;;
    --allow-no-metrics) ALLOW_NO_METRICS=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) die "argumento desconhecido: $1" ;;
  esac; shift
done
require_profile "$PROFILE"
[ "$SMOKE_ONLY" = 0 ] || [ "$SKIP_SMOKE" = 0 ] || die "--smoke-only e --skip-smoke são incompatíveis"
case "$BATCH_SIZE" in [1-9] | 10) ;; *) die "--batch-size inválido: $BATCH_SIZE (1 a 10)" ;; esac
[ "$SMOKE_ONLY" = 1 ] || [ $((RATE % BATCH_SIZE)) -eq 0 ] || die "--rate ($RATE) deve ser múltiplo de --batch-size ($BATCH_SIZE)"
case "$RUNNER" in ec2 | fargate) ;; *) die "--runner inválido: $RUNNER (use ec2 ou fargate)" ;; esac
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

# O dashboard (latência p99 do alerta, vazão por resultado, outbox) depende de a imagem em execução emitir
# `pipeline.metrics`. Este script não troca a imagem do app: sem a emissão, a carga rodaria com o dashboard cego.
if app_emits_pipeline_metrics 5; then
  log "dashboard: a aplicação emite pipeline.metrics ($(dashboard_url))"
elif [ "$ALLOW_NO_METRICS" = 1 ]; then
  log "AVISO: a aplicação não emite pipeline.metrics; o dashboard terá só métricas de infraestrutura (--allow-no-metrics)"
elif [ "$ASSUME_YES" = 1 ]; then
  die "a imagem em execução não emite pipeline.metrics (dashboard sem latência e sem contadores). Rode aws-up antes ou use --allow-no-metrics"
else
  log "AVISO: nenhuma linha pipeline.metrics nos últimos 5 min em $APP_LOG_GROUP; a imagem em execução provavelmente não tem a emissão (rode aws-up antes)."
  confirm "Continuar assim mesmo, com o dashboard só com métricas de infraestrutura?"
fi

# Tag da imagem do app em execução (o apply não pode trocá-la nem zerar o serviço)
TASKDEF="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)"
APP_TAG="$(aws ecs describe-task-definition --task-definition "$TASKDEF" --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*://')"
[ -n "$APP_TAG" ] && [ "$APP_TAG" != none ] || die "não foi possível descobrir a tag da imagem do app"

K6_TAG="k6-$(cd "$K6_DIR" && tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 -cf - Dockerfile fraud-latency.js vendor | sha256sum | cut -c1-12)"
STEADY_MIN=$(( DURATION / 60 ))
TOTAL_S=$(( WARMUP + DURATION + DRAIN ))
log "perfil=$PROFILE app=$APP_TAG k6=$K6_TAG | ${RATE} TPS: aquecimento ${WARMUP}s + steady ${DURATION}s (${STEADY_MIN} min) + drain ${DRAIN}s | alertas ${ALERT_RATE}"
if [ "$RUNNER" = ec2 ]; then
  log "k6: instância EC2 ${INSTANCE_TYPE:-padrão da arquitetura} ($([ "$USE_SPOT" = true ] && echo Spot || echo On-Demand)), $([ "$BATCH_SIZE" -eq 1 ] && echo 'envio individual (1 SendMessage por evento)' || echo "envio em lotes de $BATCH_SIZE (SendMessageBatch)")"
else
  log "k6: task Fargate ${CPU} CPU / ${MEMORY} MiB, $([ "$BATCH_SIZE" -eq 1 ] && echo 'envio individual (1 SendMessage por evento)' || echo "envio em lotes de $BATCH_SIZE (SendMessageBatch)")"
fi
confirm "Rodar o teste de carga na AWS? Aplica o override On-Demand (tasks do serviço substituídas) e gera custo."

TF_VARS=(-var-file="$VARFILE" -var-file="$LTFILE" -var "image_tag=$APP_TAG" -var "loadtest_image_tag=$K6_TAG" -var "loadtest_cpu=$CPU" -var "loadtest_memory=$MEMORY")
if [ "$RUNNER" = ec2 ]; then
  TF_VARS+=(-var "enable_loadtest_ec2=true" -var "loadtest_use_spot=$USE_SPOT")
  [ -n "$INSTANCE_TYPE" ] && TF_VARS+=(-var "loadtest_instance_type=$INSTANCE_TYPE")
fi
TASK=""; SINK_URL=""; SUB_ARN=""; REVERTED=0; SSM_CMD=""; SSM_INSTANCE=""; INSTANCE_ID=""; REGISTRY=""; IMAGE=""

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
  if [ -n "$SSM_CMD" ]; then aws ssm cancel-command --command-id "$SSM_CMD" --instance-ids "$SSM_INSTANCE" >/dev/null 2>&1 || true; fi
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
REGISTRY="${REPO%%/*}"; IMAGE="$REPO:$K6_TAG"
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

if [ "$RUNNER" = ec2 ]; then
  INSTANCE_ID="$(tf output -json loadtest_instance_ids | python3 -c 'import json,sys;print((json.load(sys.stdin) or [""])[0])')"
  [ -n "$INSTANCE_ID" ] || die "instância do k6 não foi criada"
  log "instância do k6: $INSTANCE_ID; aguardando o SSM"
  for i in $(seq 1 60); do
    [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = Online ] && break
    sleep 10
  done
  [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = Online ] \
    || die "a instância $INSTANCE_ID não ficou Online no SSM (Spot sem capacidade? tente --on-demand)"
fi
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

# Grava no CloudWatch (namespace FraudDetector/LoadTest) a fase da execução (1 aquecimento, 2 steady, 3 drain) e o TPS
# planejado, um ponto por minuto a partir de agora (o CloudWatch aceita timestamps até 2 h no futuro). O dashboard
# `<nome>-operacao` plota os dois contra a entrada real. Não bloqueia o teste se falhar.
mark_run_window() { # <rate> <duration> <warmup> <drain>
  local rate="$1" duration="$2" warmup="$3" drain="$4" data
  if ! data="$(python3 - "$rate" "$duration" "$warmup" "$drain" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
rate, duration, warmup, drain = (float(x) for x in sys.argv[1:5])
total = warmup + duration + drain
if total > 7000:
    sys.exit("janela maior que 2 h: marcadores omitidos")
start = datetime.now(timezone.utc).replace(second=0, microsecond=0)
start_exact = datetime.now(timezone.utc)
start_rate = min(rate, 200)
out = []
t = 0.0
while t <= total:
    if t < warmup:
        phase, planned = 1, start_rate + (rate - start_rate) * (t / warmup)
    elif t < warmup + duration:
        phase, planned = 2, rate
    else:
        phase, planned = 3, 0
    ts = (start_exact + timedelta(seconds=t)).replace(second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    out.append({"MetricName": "Phase", "Timestamp": ts, "Value": phase, "Unit": "None"})
    out.append({"MetricName": "PlannedTps", "Timestamp": ts, "Value": round(planned, 1), "Unit": "Count/Second"})
    t += 60
# Mantém um ponto por minuto (sem repetir timestamps).
seen, uniq = set(), []
for m in out:
    k = (m["MetricName"], m["Timestamp"])
    if k not in seen:
        seen.add(k); uniq.append(m)
print(json.dumps(uniq))
PY
)"; then
    log "AVISO: marcadores do dashboard omitidos (janela maior que 2 h)"; return 0
  fi
  python3 - "$data" <<'PY' | while IFS= read -r chunk; do
import json, sys
items = json.loads(sys.argv[1])
for i in range(0, len(items), 100):
    print(json.dumps(items[i:i + 100]))
PY
    aws cloudwatch put-metric-data --namespace FraudDetector/LoadTest --metric-data "$chunk" \
      || log "AVISO: não foi possível gravar os marcadores do teste no CloudWatch"
  done
}

# --- 5) execução de uma task k6 --------------------------------------------------------------------
# run_k6 <rótulo> <rate> <duration> <warmup> <drain> <alert-rate>
# Define RUN_BASE (prefixo dos arquivos), RUN_START/RUN_END (ISO UTC) e RUN_EXIT (exit code do k6).
run_k6() {
  local label="$1" rate="$2" duration="$3" warmup="$4" drain="$5" arate="$6" p95="${7:-}" p99="${8:-}"
  local run_id; run_id="$(date +%s | sha256sum | cut -c1-8)"
  local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  RUN_BASE="$RESULTS_DIR/${stamp}-aws-${label}-${run_id}"
  mkdir -p "$RESULTS_DIR"
  local env_json
  env_json="$(python3 - "$run_id" "$rate" "$duration" "$warmup" "$drain" "$arate" "$SINK_URL" "$p95" "$p99" "$RUNNER" "$AWS_REGION" "$TOPIC_ARN" "$BATCH_SIZE" <<'PY'
import json, sys
run_id, rate, duration, warmup, drain, arate, sink, p95, p99, runner, region, topic, batch = sys.argv[1:14]
env = {"RUN_ID": run_id, "RATE": rate, "DURATION_SECONDS": duration, "WARMUP_SECONDS": warmup, "DRAIN_SECONDS": drain,
       "ALERT_RATE": arate, "SINK_QUEUE_URL": sink, "BATCH_SIZE": batch}
if p95: env["P95_MS"] = p95
if p99: env["P99_MS"] = p99
if runner == "ec2":
    env.update({"AWS_REGION": region, "SNS_ALERTS_TOPIC_ARN": topic, "SQS_TRANSACTIONS_QUEUE": "transactions", "RESULTS_MODE": "stdout"})
    print(json.dumps(env))
else:
    print(json.dumps({"containerOverrides": [{"name": "loadtest", "environment": [{"name": k, "value": v} for k, v in env.items()]}]}))
PY
)"
  local stream
  RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mark_run_window "$rate" "$duration" "$warmup" "$drain"
  if [ "$RUNNER" = ec2 ]; then
    log "[$label] iniciando k6 em $INSTANCE_ID (run $run_id): ${rate} TPS, aquecimento ${warmup}s, steady ${duration}s, drain ${drain}s"
    stream="ec2/$run_id"
    local params; params="$(python3 - "$env_json" "$REGISTRY" "$IMAGE" "$AWS_REGION" "$LT_LOG_GROUP" "$stream" "$run_id" "$(( warmup + duration + drain + 600 ))" <<'PY'
import json, shlex, sys
env, registry, image, region, group, stream, run_id, timeout = sys.argv[1:9]
envs = " ".join(f"-e {k}={shlex.quote(str(v))}" for k, v in json.loads(env).items())
script = [
    "until docker info >/dev/null 2>&1; do sleep 3; done",
    f"aws ecr get-login-password --region {region} | docker login --username AWS --password-stdin {registry}",
    f"docker run --rm --name k6-{run_id} --log-driver awslogs --log-opt awslogs-region={region} "
    f"--log-opt awslogs-group={group} --log-opt awslogs-stream={stream} {envs} {image}",
]
print(json.dumps({"commands": script, "executionTimeout": [timeout]}))
PY
)"
    local pfile; pfile="$(mktemp)"; printf '%s' "$params" >"$pfile"
    SSM_INSTANCE="$INSTANCE_ID"
    SSM_CMD="$(aws ssm send-command --document-name AWS-RunShellScript --instance-ids "$INSTANCE_ID" \
      --parameters "file://$pfile" --timeout-seconds 60 --query 'Command.CommandId' --output text)"
    rm -f "$pfile"
    [ -n "$SSM_CMD" ] && [ "$SSM_CMD" != None ] || die "falha ao enviar o comando do k6 via SSM"
    local status="" limit=$(( (warmup + duration + drain) / 10 + 90 )) i
    for i in $(seq 1 "$limit"); do
      status="$(aws ssm get-command-invocation --command-id "$SSM_CMD" --instance-id "$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo Pending)"
      case "$status" in Pending | InProgress | Delayed) sleep 10 ;; *) break ;; esac
    done
    case "$status" in Pending | InProgress | Delayed) die "o k6 não terminou no tempo esperado ($status)" ;; esac
    RUN_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    RUN_EXIT="$(aws ssm get-command-invocation --command-id "$SSM_CMD" --instance-id "$INSTANCE_ID" --query 'ResponseCode' --output text)"
    if [ "$status" != Success ] && [ "$RUN_EXIT" = -1 ]; then
      log "AVISO: comando SSM terminou como $status sem código de saída (instância interrompida?)"
    fi
    SSM_CMD=""
    log "[$label] k6 terminou (exit $RUN_EXIT; SSM $status)"
  else
    log "[$label] iniciando task k6 (run $run_id): ${rate} TPS, aquecimento ${warmup}s, steady ${duration}s, drain ${drain}s"
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
    stream="loadtest/loadtest/$task_id"
  fi
  fetch_artifacts "$stream" "$run_id" "$RUN_BASE"
}

# Remonta os arquivos K6ART|nome|i|n|base64 dos logs da task: <base>.txt/.json/.html
fetch_artifacts() { # <log stream> <run_id> <base>
  local stream="$1" run_id="$2" base="$3" tries
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
  # O smoke valida o caminho (permissões, SigV4, sink, entrega): ~600 alertas não sustentam um p99, então a latência só falha acima de 5 s
  run_k6 smoke $(( (50 + BATCH_SIZE - 1) / BATCH_SIZE * BATCH_SIZE )) 60 0 30 0.2 5000 5000
  if [ "$RUN_EXIT" != 0 ]; then
    PASSED=0; log "smoke FALHOU (exit $RUN_EXIT): corrija permissões/assinatura/sink antes de subir a carga"
  fi
fi

if [ "$SMOKE_ONLY" = 1 ]; then
  [ "$PASSED" = 1 ] && log "smoke APROVADO (--smoke-only: carga principal não executada)" || log "smoke REPROVADO"
  [ "$PASSED" = 1 ]
  exit
fi

if [ "$PASSED" = 1 ]; then
  run_k6 main "$RATE" "$DURATION" "$WARMUP" "$DRAIN" "$ALERT_RATE"
  MAIN_EXIT="$RUN_EXIT"
  [ -f "$RUN_BASE.json" ] || die "sem resumo JSON do k6; veja os logs em $LT_LOG_GROUP"
  log "aguardando 3 min para as métricas do CloudWatch chegarem"; sleep 180
  DLQ_ARGS=(); for q in "${DLQS[@]}"; do DLQ_ARGS+=(--dlq "$q"); done
  GEN_ARGS=(); GEN_DESC="Fargate $CPU CPU/$MEMORY MiB"
  if [ "$RUNNER" = ec2 ]; then
    GEN_ARGS=(--generator-instance "$INSTANCE_ID")
    GEN_DESC="EC2 $(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].[InstanceType,InstanceLifecycle]' --output text | tr '\t' ' ' | sed 's/None/on-demand/')"
  fi
  DASH_START="$(date -u -d "$RUN_START - 5 minutes" +%Y-%m-%dT%H:%M:%S.000Z)"
  DASH_END="$(date -u -d "$RUN_END + 8 minutes" +%Y-%m-%dT%H:%M:%S.000Z)"
  DASH_URL="$(dashboard_url "$DASH_START" "$DASH_END")"
  python3 "$SCRIPTS_DIR/loadtest_report.py" --summary "$RUN_BASE.json" --start "$RUN_START" --end "$RUN_END" \
    --rate "$RATE" --duration "$DURATION" --warmup "$WARMUP" --cluster "$CLUSTER" --service "$SERVICE" --db "$DB_ID" \
    --topic "$TOPIC_NAME" --desired "$DESIRED" "${DLQ_ARGS[@]}" \
    "${GEN_ARGS[@]}" \
    --meta "Perfil: $PROFILE | app: $APP_TAG | k6: $K6_TAG ($GEN_DESC) | tasks ECS: $RUNNING | dashboard: $DASH_URL" \
    --out "$RUN_BASE-avaliacao.md" || PASSED=0
  log "avaliação: $RUN_BASE-avaliacao.md (k6 exit $MAIN_EXIT)"
  log "dashboard da janela do teste: $DASH_URL"
fi

[ "$PASSED" = 1 ] && log "APROVADO" || log "REPROVADO ou inválido: veja a avaliação"
[ "$PASSED" = 1 ]
