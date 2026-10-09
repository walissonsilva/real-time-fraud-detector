#!/usr/bin/env bash
# Pausa: ECS em 0 tasks e RDS parado (até 7 dias). NÃO zera NAT, Redis e storage — para isso, destroy.sh (lean).
# Uso: pause.sh [--yes]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = --yes ] && ASSUME_YES=1
check_aws
confirm "Pausar o ambiente (ECS=0 e RDS parado)?"

if [ -n "$(service_desired || true)" ]; then
  MAX="$(aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids "service/$CLUSTER/$SERVICE" --query 'ScalableTargets[0].MaxCapacity' --output text)"
  [[ "$MAX" =~ ^[0-9]+$ ]] || MAX=1
  log "zerando autoscaling e desired_count"
  set_autoscaling 0 "$MAX"
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 >/dev/null
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
else
  log "serviço ECS não encontrado; seguindo"
fi

case "$(db_status)" in
  available) log "parando RDS"; aws rds stop-db-instance --db-instance-identifier "$DB_ID" >/dev/null ;;
  absent) log "RDS não existe" ;;
  *) log "RDS em estado '$(db_status)'; nada a fazer" ;;
esac
log "pausado. Continuam cobrando: NAT Gateway (lean), ElastiCache, storage do RDS/ECR/logs. RDS reinicia sozinho em 7 dias."
