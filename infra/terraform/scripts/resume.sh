#!/usr/bin/env bash
# Retoma após pause.sh: liga o RDS e restaura o serviço com os valores do perfil.
# Uso: resume.sh <lean|full> [--yes]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PROFILE="${1:-}"; [ "${2:-}" = --yes ] && ASSUME_YES=1
require_profile "$PROFILE"
check_aws
VARFILE="$TF_DIR/$PROFILE.tfvars"
MIN="$(tfvar "$VARFILE" service_min_count)"; MAX="$(tfvar "$VARFILE" service_max_count)"
confirm "Retomar '$PROFILE' (RDS ligado, ECS com $MIN a $MAX tasks)?"

ensure_rds_available
set_autoscaling "$MIN" "$MAX"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count "$MIN" >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
log "retomado: $(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[runningCount,desiredCount]' --output text | tr '\t' '/') tasks"
