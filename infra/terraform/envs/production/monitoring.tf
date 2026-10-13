# ---------- Alarmes ----------
resource "aws_sns_topic" "ops" {
  name              = "${var.name}-ops-alerts"
  kms_master_key_id = local.kms_key_arn # alias/aws/sns não permite publicação pelo CloudWatch
}

resource "aws_sns_topic_subscription" "ops_email" {
  topic_arn = aws_sns_topic.ops.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

data "aws_iam_policy_document" "ops_topic" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ops.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "ops" {
  arn    = aws_sns_topic.ops.arn
  policy = data.aws_iam_policy_document.ops_topic.json
}

locals {
  dlqs = merge(
    { transactions = aws_sqs_queue.transactions_dlq },
    { for k, q in aws_sqs_queue.channel_dlq : k => q },
  )
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  for_each            = local.dlqs
  alarm_name          = "${var.name}-dlq-${each.key}-not-empty"
  alarm_description   = "Mensagens na DLQ ${each.value.name}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "transactions_age" {
  alarm_name          = "${var.name}-transactions-oldest-message-age"
  alarm_description   = "Backlog na fila transactions (consumo atrasado)"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.transactions.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 60
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# SLO de latência (ADR-08, RNF-03): p99 do alerta, do `ingestedAt` ao aceite do SNS, acima de 500 ms.
# O p99 só é confiável com amostras suficientes: com menos de 20 alertas na janela de 5 min a expressão
# devolve 0 e o alarme não dispara por causa de um único alerta lento em tráfego baixo.
resource "aws_cloudwatch_metric_alarm" "alert_latency_p99" {
  alarm_name          = "${var.name}-alert-latency-p99-high"
  alarm_description   = "p99 da latência do alerta acima de ${var.alert_latency_slo_ms} ms (SLO do RNF-03), avaliado em janelas de 5 min"
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alert_latency_slo_ms
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]

  metric_query {
    id          = "slo"
    expression  = "IF(n >= 20, p99, 0)"
    label       = "p99 da latência do alerta (ms)"
    return_data = true
  }

  metric_query {
    id = "p99"
    metric {
      namespace   = local.pipeline_metric_namespace
      metric_name = "AlertLatencyMs"
      period      = 300
      stat        = "p99"
    }
  }

  metric_query {
    id = "n"
    metric {
      namespace   = local.pipeline_metric_namespace
      metric_name = "AlertLatencyMs"
      period      = 300
      stat        = "SampleCount"
    }
  }
}

# Outbox parado (ADR-04, ADR-08): o alerta está gravado, mas não saiu para o SNS. O relay tenta a cada 1 s
# (backoff de até 60 s por entrada), então uma entrada pendente há mais de 30 s por 2 min seguidos indica relay,
# SNS ou banco com problema. Os gauges são atualizados a cada execução do relay; sem dados, não dispara.
resource "aws_cloudwatch_metric_alarm" "outbox_stuck" {
  alarm_name          = "${var.name}-outbox-oldest-pending-high"
  alarm_description   = "Alerta pendente no outbox há mais de ${var.outbox_pending_max_age_s} s (publicação no SNS ou relay com problema)"
  namespace           = local.pipeline_metric_namespace
  metric_name         = "OutboxOldestPendingAgeMs"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.outbox_pending_max_age_s * 1000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  alarm_name          = "${var.name}-ecs-cpu-high"
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.app.name }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu-high"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.name}-rds-free-storage-low"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks" {
  count               = var.container_insights && local.start ? 1 : 0
  alarm_name          = "${var.name}-ecs-running-below-desired"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.app.name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = var.service_min_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
}

# ---------- Orçamento ----------
resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# ---------- CloudTrail / GuardDuty ----------
resource "aws_s3_bucket" "cloudtrail" {
  count         = var.enable_cloudtrail ? 1 : 0
  bucket        = "${var.name}-cloudtrail-${local.account_id}"
  force_destroy = var.profile == "lean"
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  count                   = var.enable_cloudtrail ? 1 : 0
  bucket                  = aws_s3_bucket.cloudtrail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  count  = var.enable_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.cloudtrail[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  count  = var.enable_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.cloudtrail[0].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 365 }
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  count = var.enable_cloudtrail ? 1 : 0

  statement {
    sid       = "AclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail[0].arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }

  statement {
    sid       = "Write"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cloudtrail[0].arn}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.cloudtrail[0].arn, "${aws_s3_bucket.cloudtrail[0].arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  count      = var.enable_cloudtrail ? 1 : 0
  bucket     = aws_s3_bucket.cloudtrail[0].id
  policy     = data.aws_iam_policy_document.cloudtrail_bucket[0].json
  depends_on = [aws_s3_bucket_public_access_block.cloudtrail]
}

resource "aws_cloudtrail" "main" {
  count                         = var.enable_cloudtrail ? 1 : 0
  name                          = var.name
  s3_bucket_name                = aws_s3_bucket.cloudtrail[0].id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  depends_on                    = [aws_s3_bucket_policy.cloudtrail]
}

resource "aws_guardduty_detector" "main" {
  count  = var.enable_guardduty ? 1 : 0
  enable = true
}

# ---------- Regras dinâmicas (AppConfig): defasagem, divergência e taxa de alertas ----------
# A aplicação escreve a linha JSON `rules.metrics` a cada 60 s; os filtros abaixo a transformam em métricas (research D-06).
locals {
  rules_metric_namespace = "FraudDetector/Rules"
  rules_metrics = {
    RulesActiveRevision        = "$.RulesActiveRevision"
    RulesLastRefreshAgeSeconds = "$.RulesLastRefreshAgeSeconds"
    RulesRefreshFailures       = "$.RulesRefreshFailures"
    AlertsCreated              = "$.AlertsCreated"
  }
}

resource "aws_cloudwatch_log_metric_filter" "rules" {
  for_each       = local.rules_metrics
  name           = "${var.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.message = \"rules.metrics\" && ${each.value} = * }"

  metric_transformation {
    name      = each.key
    namespace = local.rules_metric_namespace
    value     = each.value
  }
}

# Última consulta bem-sucedida há mais de 90 s (SLO de frescor: 30 s; tolera três ciclos de poll perdidos).
resource "aws_cloudwatch_metric_alarm" "rules_refresh_stale" {
  alarm_name          = "${var.name}-rules-refresh-stale"
  alarm_description   = "Instâncias sem atualizar as regras há mais de 90 s (AppConfig indisponível ou consulta falhando)"
  namespace           = local.rules_metric_namespace
  metric_name         = "RulesLastRefreshAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.rules]
}

# Instâncias em revisões diferentes por mais que o rollout + bake (padrão 20 min > 10 + 5): rollout travado.
resource "aws_cloudwatch_metric_alarm" "rules_revision_diverged" {
  alarm_name          = "${var.name}-rules-revision-diverged"
  alarm_description   = "Instâncias em revisões de regras diferentes por mais de ${var.rules_divergence_minutes} min (rollout travado)"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = var.rules_divergence_minutes
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]

  metric_query {
    id          = "spread"
    expression  = "highest - lowest"
    label       = "Diferença entre a maior e a menor revisão ativa"
    return_data = true
  }
  metric_query {
    id = "highest"
    metric {
      namespace   = local.rules_metric_namespace
      metric_name = "RulesActiveRevision"
      period      = 60
      stat        = "Maximum"
    }
  }
  metric_query {
    id = "lowest"
    metric {
      namespace   = local.rules_metric_namespace
      metric_name = "RulesActiveRevision"
      period      = 60
      stat        = "Minimum"
    }
  }
  depends_on = [aws_cloudwatch_log_metric_filter.rules]
}

# Falhas de refresh em 2 de 3 minutos: cobre documento rejeitado pelas instâncias e AppConfig fora. Também alimenta o
# rollback automático (alarme composto em appconfig.tf), que reverte um documento rejeitado durante o rollout/bake.
resource "aws_cloudwatch_metric_alarm" "rules_refresh_failures" {
  alarm_name          = "${var.name}-rules-refresh-failures"
  alarm_description   = "Falhas ao consultar ou ativar as regras (documento rejeitado ou AppConfig fora)"
  namespace           = local.rules_metric_namespace
  metric_name         = "RulesRefreshFailures"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.rules]
}

# Taxa de alertas fora da banda de anomalia (pico ou queda brusca). O modelo de anomalia precisa de histórico:
# no início o alarme é pouco sensível (research D-06).
resource "aws_cloudwatch_metric_alarm" "rules_alert_rate_anomaly" {
  alarm_name          = "${var.name}-rules-alert-rate-anomaly"
  alarm_description   = "Taxa de alertas fora da faixa esperada (possível regra com falsos positivos ou que deixou de pegar fraude)"
  comparison_operator = "LessThanLowerOrGreaterThanUpperThreshold"
  threshold_metric_id = "band"
  evaluation_periods  = 5
  datapoints_to_alarm = 4
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.ops.arn]

  metric_query {
    id          = "alerts"
    return_data = true
    metric {
      namespace   = local.rules_metric_namespace
      metric_name = "AlertsCreated"
      period      = 60
      stat        = "Sum"
    }
  }
  metric_query {
    id          = "band"
    expression  = "ANOMALY_DETECTION_BAND(alerts, 3)"
    label       = "Faixa esperada de alertas por minuto"
    return_data = true
  }
  depends_on = [aws_cloudwatch_log_metric_filter.rules]
}

# ---------- Pipeline (dashboard): vazão por resultado, entregas, DLQ e outbox ----------
# A linha `pipeline.metrics` (MetricsLogPublisher) sai a cada 60 s com deltas e gauges; `alert.published` (uma por alerta)
# carrega `latencyMs` (ingestedAt → aceite do SNS), de onde o CloudWatch calcula p50/p95/p99 do SLO de 500 ms.
locals {
  pipeline_metric_namespace = "FraudDetector/Pipeline"
  pipeline_metrics = {
    EventsAlerted            = "$.EventsAlerted"
    EventsNoAlert            = "$.EventsNoAlert"
    EventsDuplicate          = "$.EventsDuplicate"
    EventsTransientFailure   = "$.EventsTransientFailure"
    EventsRejected           = "$.EventsRejected"
    DeliveriesDelivered      = "$.DeliveriesDelivered"
    DeliveriesDeadLettered   = "$.DeliveriesDeadLettered"
    DeliveriesInfraFailure   = "$.DeliveriesInfraFailure"
    DeliveriesFallback       = "$.DeliveriesFallback"
    DeliveriesDeferred       = "$.DeliveriesDeferred"
    BreakerAntifraud         = "$.BreakerAntifraud"
    BreakerPush              = "$.BreakerPush"
    BreakerSms               = "$.BreakerSms"
    DlqMessages              = "$.DlqMessages"
    OutboxPublishFailures    = "$.OutboxPublishFailures"
    OutboxRepublished        = "$.OutboxRepublished"
    OutboxPending            = "$.OutboxPending"
    OutboxOldestPendingAgeMs = "$.OutboxOldestPendingAgeMs"
  }
}

resource "aws_cloudwatch_log_metric_filter" "pipeline" {
  for_each       = local.pipeline_metrics
  name           = "${var.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.message = \"pipeline.metrics\" && ${each.value} = * }"

  metric_transformation {
    name      = each.key
    namespace = local.pipeline_metric_namespace
    value     = each.value
  }
}

resource "aws_cloudwatch_log_metric_filter" "alert_latency" {
  name           = "${var.name}-AlertLatencyMs"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.message = \"alert.published\" && $.latencyMs = * }"

  metric_transformation {
    name      = "AlertLatencyMs"
    namespace = local.pipeline_metric_namespace
    value     = "$.latencyMs"
    unit      = "Milliseconds"
  }
}
