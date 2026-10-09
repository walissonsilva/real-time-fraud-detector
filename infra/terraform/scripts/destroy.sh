#!/usr/bin/env bash
# Destrói o ambiente lean (zera o custo). O perfil full NÃO é destruído por script (RDS com deletion protection).
# O bucket do state (bootstrap) é mantido. O banco é apagado: o próximo up.sh recria e migra de novo.
# Uso: destroy.sh lean [--plan-only] [--yes]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PROFILE="${1:-}"; shift || true
PLAN_ONLY=0
while [ $# -gt 0 ]; do case "$1" in --yes) ASSUME_YES=1 ;; --plan-only) PLAN_ONLY=1 ;; *) die "argumento desconhecido: $1" ;; esac; shift; done
[ "$PROFILE" = full ] && die "destroy do perfil full não é automatizado (deletion protection e dados). Faça manualmente, ciente do risco."
require_profile "$PROFILE"
check_aws
tf_init
VARFILE="$TF_DIR/$PROFILE.tfvars"
[ "$(tfvar "$VARFILE" ephemeral)" = true ] || die "$PROFILE.tfvars não tem ephemeral = true"

ensure_rds_available   # evita falhas de refresh com RDS parado/transitório
if [ "$PLAN_ONLY" = 1 ]; then tf plan -destroy -input=false -var-file="$VARFILE"; exit 0; fi
log "isto APAGA RDS (sem snapshot), Redis, filas, ECR e imagens, logs e demais recursos do perfil $PROFILE"
tf plan -destroy -input=false -var-file="$VARFILE" -out=destroy.plan | tail -3
confirm "Confirmar destroy do '$PROFILE'?"
tf apply -input=false destroy.plan
rm -f "$TF_DIR/destroy.plan"
log "destruído. Restam apenas o bucket de state e recursos fora do Terraform."
