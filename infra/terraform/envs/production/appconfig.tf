# ---------- Regras de detecção dinâmicas (AWS AppConfig) ----------
# As instâncias consultam o perfil `fraud-rules` (specs/002-appconfig-dynamic-rules). Alterar, reverter e validar
# regras não exige redeploy. A primeira revisão é semeada por scripts/rules/publish-rules.sh depois do `apply`
# (o recurso do provedor não define o Version-Label usado como revisão); até lá as tarefas não sobem (fail-fast).

resource "aws_appconfig_application" "rules" {
  name        = "${var.name}-rules"
  description = "Regras de decisão de transações suspeitas (Rule v1)"
}

resource "aws_appconfig_environment" "production" {
  application_id = aws_appconfig_application.rules.id
  name           = "production"
  description    = "Ambiente de produção das regras"

  # Rollback automático: se o alarme composto entrar em ALARM durante o rollout ou o bake, o AppConfig reverte (FR-004).
  monitor {
    alarm_arn      = aws_cloudwatch_composite_alarm.rules_rollback.arn
    alarm_role_arn = aws_iam_role.appconfig_monitors.arn
  }
}

# O AppConfig aceita no máximo 5 monitores por ambiente; um alarme composto reúne todos os sinais de rollback
# (saúde do processamento, falhas de refresh e taxa de alertas) e conta como um só.
locals {
  rules_rollback_alarm_names = concat(
    [for a in aws_cloudwatch_metric_alarm.dlq_not_empty : a.alarm_name],
    [
      aws_cloudwatch_metric_alarm.transactions_age.alarm_name,
      aws_cloudwatch_metric_alarm.rules_refresh_failures.alarm_name,
      aws_cloudwatch_metric_alarm.rules_alert_rate_anomaly.alarm_name,
    ],
  )
}

resource "aws_cloudwatch_composite_alarm" "rules_rollback" {
  alarm_name        = "${var.name}-rules-rollback"
  alarm_description = "Qualquer sinal de problema durante um rollout de regras reverte o deployment (AppConfig)"
  alarm_rule        = join(" OR ", [for n in local.rules_rollback_alarm_names : "ALARM(\"${n}\")"])
}

data "aws_iam_policy_document" "appconfig_monitors_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["appconfig.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "appconfig_monitors" {
  name               = "${var.name}-appconfig-monitors"
  assume_role_policy = data.aws_iam_policy_document.appconfig_monitors_assume.json
}

# DescribeAlarms é somente leitura; a documentação do AppConfig usa Resource "*" para o papel de monitores.
data "aws_iam_policy_document" "appconfig_monitors" {
  statement {
    sid       = "ReadAlarmState"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "appconfig_monitors" {
  role   = aws_iam_role.appconfig_monitors.id
  policy = data.aws_iam_policy_document.appconfig_monitors.json
}

resource "aws_appconfig_configuration_profile" "rules" {
  application_id = aws_appconfig_application.rules.id
  name           = "fraud-rules"
  description    = "Documento de regras (RulesDocument v1)"
  location_uri   = "hosted"
  type           = "AWS.Freeform"

  # O AppConfig só valida JSON Schema draft 4: usa-se o espelho estrutural do contrato (research D-04).
  # A validação completa (expressões, ruleId único etc.) roda no script de publicação e na instância.
  validator {
    type    = "JSON_SCHEMA"
    content = file("${path.module}/../../../../docs/contratos/rules-document.v1.draft4.schema.json")
  }
}

# Padrão: gradual e curto, com janela de observação para o rollback automático por alarme (FR-022).
resource "aws_appconfig_deployment_strategy" "gradual" {
  name                           = "${var.name}-rules-gradual"
  description                    = "Linear 20% em 10 min, bake de 5 min"
  deployment_duration_in_minutes = 10
  growth_factor                  = 20
  growth_type                    = "LINEAR"
  final_bake_time_in_minutes     = 5
  replicate_to                   = "NONE"
}

# Urgências e reversão de uma revisão já concluída.
resource "aws_appconfig_deployment_strategy" "immediate" {
  name                           = "${var.name}-rules-immediate"
  description                    = "Imediato, sem bake"
  deployment_duration_in_minutes = 0
  growth_factor                  = 100
  growth_type                    = "LINEAR"
  final_bake_time_in_minutes     = 0
  replicate_to                   = "NONE"
}
