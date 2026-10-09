#!/usr/bin/env bash
# Funções comuns dos scripts de ciclo de vida do ambiente (lean/full). Não executar diretamente.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "$SCRIPTS_DIR/../envs/production" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/../../.." && pwd)"

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
NAME="fraud-detector"
CLUSTER="$NAME"
SERVICE="$NAME"
DB_ID="$NAME"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merro:\033[0m %s\n' "$*" >&2; exit 1; }

require_profile() {
  case "${1:-}" in lean | full) ;; *) die "perfil inválido: '${1:-}' (use lean ou full)" ;; esac
}

check_aws() {
  command -v aws >/dev/null || die "aws CLI não encontrada"
  command -v terraform >/dev/null || die "terraform não encontrado"
  aws sts get-caller-identity --query Arn --output text >/dev/null 2>&1 \
    || die "credenciais AWS inválidas (rode: aws sso login --profile <perfil> e export AWS_PROFILE=<perfil>)"
  log "conta $(aws sts get-caller-identity --query Account --output text), região $AWS_REGION"
}

# Lê um valor simples de um .tfvars: tfvar <arquivo> <nome>
tfvar() {
  grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" | head -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*(#.*)?$//; s/^"//; s/"$//'
}

confirm() {
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  [ -t 0 ] || die "sem terminal para confirmar; reexecute com --yes depois de revisar o plano"
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[yY]$ ]] || die "cancelado"
}

tf() { (cd "$TF_DIR" && terraform "$@"); }

tf_init() {
  [ -f "$TF_DIR/backend.hcl" ] || die "falta $TF_DIR/backend.hcl (veja backend.hcl.example)"
  [ -f "$TF_DIR/secrets.auto.tfvars" ] || die "falta $TF_DIR/secrets.auto.tfvars com alert_email"
  tf init -input=false -backend-config=backend.hcl >/dev/null
}

db_status() { aws rds describe-db-instances --db-instance-identifier "$DB_ID" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo "absent"; }

# O AWS CLI não tem waiter para "stopped": poll até o status desejado (timeout ~30 min).
wait_db_status() { # <status>
  local i s
  for i in $(seq 1 180); do
    s="$(db_status)"; [ "$s" = "$1" ] && return 0
    sleep 10
  done
  die "RDS não chegou a '$1' (último estado: $s)"
}

# Garante o RDS disponível (o Terraform e o ECS dependem dele). Religa se estiver parado.
ensure_rds_available() {
  local s; s="$(db_status)"
  case "$s" in
    absent | available) return 0 ;;
    stopping) log "RDS parando; aguardando"; wait_db_status stopped; ensure_rds_available ;;
    stopped) log "RDS parado; iniciando (alguns minutos)"; aws rds start-db-instance --db-instance-identifier "$DB_ID" >/dev/null; aws rds wait db-instance-available --db-instance-identifier "$DB_ID" ;;
    *) log "RDS em estado '$s'; aguardando ficar disponível"; aws rds wait db-instance-available --db-instance-identifier "$DB_ID" ;;
  esac
}

service_desired() { aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[?status==`ACTIVE`]|[0].desiredCount' --output text 2>/dev/null | sed 's/None//' ; }

set_autoscaling() { # <min> <max>
  aws application-autoscaling register-scalable-target --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount --resource-id "service/$CLUSTER/$SERVICE" \
    --min-capacity "$1" --max-capacity "$2" >/dev/null
}

# Plano salvo + apply do arquivo (nunca -auto-approve): tf_apply <args do terraform plan>
tf_apply() {
  local f="$TF_DIR/.apply.plan"
  tf plan -input=false -out="$f" "$@" | tail -3
  tf apply -input=false "$f"
  rm -f "$f"
}
