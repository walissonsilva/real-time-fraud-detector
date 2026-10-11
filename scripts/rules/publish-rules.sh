#!/usr/bin/env bash
# Publica, reverte ou interrompe o deployment das regras de detecção no AWS AppConfig (sem redeploy da aplicação).
#
# Uso:
#   publish-rules.sh <arquivo.json> [--strategy gradual|immediate] [--dry-run]   publica uma nova revisão
#   publish-rules.sh --rollback <revisão>  [--strategy gradual|immediate] [--dry-run]   volta a uma revisão anterior
#   publish-rules.sh --stop [--dry-run]                                          para o rollout em andamento
#
# - A revisão é um rótulo monotônico `r` + carimbo UTC (rYYYYMMDDHHMMSS; o AppConfig exige um caractere não numérico) gravado como Version-Label da versão hospedada;
#   é o identificador que as instâncias expõem nas métricas (research D-03).
# - Antes de publicar, o documento é validado com a mesma função das instâncias (contrato, expressão, ruleId único,
#   sem WINDOWED, ao menos uma regra ACTIVE). Documento inválido encerra o script sem criar versão.
# - Estratégia padrão: gradual (10 min + 5 min de bake, com rollback automático por alarme). Em urgências e em
#   --rollback o padrão é immediate.
# - IDs: variáveis APPCONFIG_APPLICATION, APPCONFIG_ENVIRONMENT, APPCONFIG_PROFILE, APPCONFIG_STRATEGY_GRADUAL e
#   APPCONFIG_STRATEGY_IMMEDIATE, ou, se ausentes, `terraform output` de infra/terraform/envs/production.
# - Pré-requisitos: AWS CLI com o perfil de operador de fraude e `npm ci` no checkout (a validação usa ts-node).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform/envs/production"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merro:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit "${1:-2}"; }

MODE=publish
FILE=""
STRATEGY=""
ROLLBACK_REVISION=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --strategy) STRATEGY="${2:?informe gradual ou immediate}"; shift ;;
    --rollback) MODE=rollback; ROLLBACK_REVISION="${2:?informe a revisão (rótulo)}"; shift ;;
    --stop) MODE=stop ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage 0 ;;
    -*) die "opção desconhecida: $1" ;;
    *) [ -z "$FILE" ] || die "informe um único arquivo"; FILE="$1" ;;
  esac
  shift
done

case "$STRATEGY" in "" | gradual | immediate) ;; *) die "estratégia inválida: '$STRATEGY' (use gradual ou immediate)" ;; esac
if [ "$MODE" = publish ]; then
  [ -n "$FILE" ] || usage
  [ -f "$FILE" ] || die "arquivo não encontrado: $FILE"
  FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
  STRATEGY="${STRATEGY:-gradual}"
elif [ "$MODE" = rollback ]; then
  [[ "$ROLLBACK_REVISION" =~ ^r[1-9][0-9]*$ ]] || die "revisão inválida: '$ROLLBACK_REVISION' (esperado o rótulo, ex.: r20261010120000)"
  STRATEGY="${STRATEGY:-immediate}"
fi

# Valores de um output do Terraform, a menos que a variável de ambiente correspondente esteja definida.
resolve() { # resolve <VAR> <output>
  local current="${!1:-}"
  if [ -n "$current" ]; then printf '%s' "$current"; return; fi
  if [ "$DRY_RUN" = 1 ]; then printf '<%s>' "$2"; return; fi
  command -v terraform >/dev/null || die "defina $1 ou instale o terraform para ler os outputs"
  terraform -chdir="$TF_DIR" output -raw "$2" 2>/dev/null || die "não foi possível ler o output '$2' do Terraform (defina $1)"
}

APP_ID="$(resolve APPCONFIG_APPLICATION appconfig_application_id)"
ENV_ID="$(resolve APPCONFIG_ENVIRONMENT appconfig_environment_id)"
PROFILE_ID="$(resolve APPCONFIG_PROFILE appconfig_profile_id)"
strategy_id() { # gradual | immediate
  if [ "$1" = gradual ]; then resolve APPCONFIG_STRATEGY_GRADUAL appconfig_strategy_gradual_id
  else resolve APPCONFIG_STRATEGY_IMMEDIATE appconfig_strategy_immediate_id; fi
}

# Executa o comando da AWS, ou só o imprime com --dry-run.
run_aws() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] aws %s\n' "$*" >&2
    return 0
  fi
  aws "$@"
}

start_deployment() { # start_deployment <versão-hospedada> <estratégia> <descrição>
  local sid; sid="$(strategy_id "$2")"
  if [ "$DRY_RUN" = 1 ]; then
    run_aws appconfig start-deployment --application-id "$APP_ID" --environment-id "$ENV_ID" \
      --configuration-profile-id "$PROFILE_ID" --deployment-strategy-id "$sid" --configuration-version "$1" \
      --description "$3" --query DeploymentNumber --output text
    DEPLOYMENT_NUMBER="<deployment>"
  else
    DEPLOYMENT_NUMBER="$(aws appconfig start-deployment --application-id "$APP_ID" --environment-id "$ENV_ID" \
      --configuration-profile-id "$PROFILE_ID" --deployment-strategy-id "$sid" --configuration-version "$1" \
      --description "$3" --query DeploymentNumber --output text)"
  fi
}

follow_hint() {
  log "acompanhar: aws appconfig get-deployment --application-id $APP_ID --environment-id $ENV_ID --deployment-number ${DEPLOYMENT_NUMBER:-<n>} --query State --output text"
}

case "$MODE" in
  publish)
    log "validando $FILE (contrato, expressões, ruleId único, sem WINDOWED, ao menos uma regra ACTIVE)"
    (cd "$REPO_ROOT" && npx --no-install ts-node scripts/rules/validate-rules.ts "$FILE") \
      || die "documento inválido; nada foi publicado"

    LABEL="r$(date -u +%Y%m%d%H%M%S)"
    log "criando a versão hospedada, revisão (Version-Label) $LABEL"
    if [ "$DRY_RUN" = 1 ]; then
      run_aws appconfig create-hosted-configuration-version --application-id "$APP_ID" \
        --configuration-profile-id "$PROFILE_ID" --content-type application/json --version-label "$LABEL" \
        --content "fileb://$FILE" --query VersionNumber --output text /dev/null
      VERSION_NUMBER="<versão>"
    else
      VERSION_NUMBER="$(aws appconfig create-hosted-configuration-version --application-id "$APP_ID" \
        --configuration-profile-id "$PROFILE_ID" --content-type application/json --version-label "$LABEL" \
        --content "fileb://$FILE" --query VersionNumber --output text /dev/null)"
    fi

    log "iniciando o deployment (estratégia $STRATEGY)"
    start_deployment "$VERSION_NUMBER" "$STRATEGY" "regras revisão $LABEL"
    log "revisão $LABEL publicada (versão hospedada $VERSION_NUMBER, deployment $DEPLOYMENT_NUMBER)"
    follow_hint
    ;;

  rollback)
    log "procurando a versão hospedada com Version-Label $ROLLBACK_REVISION"
    if [ "$DRY_RUN" = 1 ]; then
      run_aws appconfig list-hosted-configuration-versions --application-id "$APP_ID" \
        --configuration-profile-id "$PROFILE_ID" --query "Items[?VersionLabel=='$ROLLBACK_REVISION'].VersionNumber | [0]" --output text
      VERSION_NUMBER="<versão>"
    else
      VERSION_NUMBER="$(aws appconfig list-hosted-configuration-versions --application-id "$APP_ID" \
        --configuration-profile-id "$PROFILE_ID" --query "Items[?VersionLabel=='$ROLLBACK_REVISION'].VersionNumber | [0]" --output text)"
      { [ -n "$VERSION_NUMBER" ] && [ "$VERSION_NUMBER" != None ]; } \
        || die "nenhuma versão hospedada com o rótulo '$ROLLBACK_REVISION'"
    fi
    log "revertendo para a revisão $ROLLBACK_REVISION (estratégia $STRATEGY)"
    start_deployment "$VERSION_NUMBER" "$STRATEGY" "rollback para a revisão $ROLLBACK_REVISION"
    log "deployment $DEPLOYMENT_NUMBER iniciado"
    follow_hint
    ;;

  stop)
    if [ "$DRY_RUN" = 1 ]; then
      run_aws appconfig list-deployments --application-id "$APP_ID" --environment-id "$ENV_ID" \
        --query "Items[?State=='DEPLOYING'] | [0].DeploymentNumber" --output text
      DEPLOYMENT_NUMBER="<deployment>"
    else
      DEPLOYMENT_NUMBER="$(aws appconfig list-deployments --application-id "$APP_ID" --environment-id "$ENV_ID" \
        --query "Items[?State=='DEPLOYING'] | [0].DeploymentNumber" --output text)"
      { [ -n "$DEPLOYMENT_NUMBER" ] && [ "$DEPLOYMENT_NUMBER" != None ]; } || die "nenhum rollout em andamento"
    fi
    log "parando o deployment $DEPLOYMENT_NUMBER (reverte para a configuração anterior)"
    run_aws appconfig stop-deployment --application-id "$APP_ID" --environment-id "$ENV_ID" --deployment-number "$DEPLOYMENT_NUMBER"
    ;;
esac
