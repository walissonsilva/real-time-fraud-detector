# Dashboard operacional e de teste de carga. Fontes:
#  - AWS/SQS, AWS/ECS, ECS/ContainerInsights, AWS/RDS, AWS/ElastiCache (infra);
#  - FraudDetector/Pipeline e FraudDetector/Rules (linhas de log da aplicação → metric filters em monitoring.tf);
#  - FraudDetector/LoadTest (marcadores gravados pelo loadtest.sh: fase e TPS planejado).
# Métricas SQS/RDS chegam ao CloudWatch com 1 a 5 min de atraso; os números finais do teste vêm do relatório do k6.
locals {
  dash = {
    tx      = aws_sqs_queue.transactions.name
    dlqs    = [for k, q in local.dlqs : q.name]
    chan    = [for k, q in aws_sqs_queue.channel : q.name]
    pipe    = local.pipeline_metric_namespace
    rules   = local.rules_metric_namespace
    lt      = "FraudDetector/LoadTest"
    cluster = aws_ecs_cluster.main.name
    service = aws_ecs_service.app.name
    db      = aws_db_instance.main.identifier
    redis   = "${aws_elasticache_replication_group.main.replication_group_id}-001"
  }

  dash_alarms = concat(
    [for a in aws_cloudwatch_metric_alarm.dlq_not_empty : a.arn],
    [
      aws_cloudwatch_metric_alarm.transactions_age.arn,
      aws_cloudwatch_metric_alarm.ecs_cpu.arn,
      aws_cloudwatch_metric_alarm.rds_cpu.arn,
      aws_cloudwatch_metric_alarm.rds_storage.arn,
      aws_cloudwatch_metric_alarm.rules_refresh_stale.arn,
      aws_cloudwatch_metric_alarm.rules_revision_diverged.arn,
      aws_cloudwatch_metric_alarm.rules_refresh_failures.arn,
      aws_cloudwatch_metric_alarm.rules_alert_rate_anomaly.arn,
    ],
    aws_cloudwatch_metric_alarm.ecs_running_tasks[*].arn,
  )

  # DLQs somadas em uma expressão: m0 + m1 + m2
  dlq_sum_metrics = concat(
    [for i, q in local.dash.dlqs : ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", q, { id = "d${i}", stat = "Maximum", visible = false }]],
    [[{ expression = join(" + ", [for i, q in local.dash.dlqs : "d${i}"]), label = "Mensagens em DLQs", id = "dsum" }]],
  )

  # Número de tasks só existe com Container Insights.
  tasks_widget = var.container_insights ? [{
    type = "metric", width = 8, height = 6, x = 8, y = 25
    properties = {
      title  = "ECS: tasks rodando × desejadas"
      region = var.region, view = "timeSeries", period = 60, stat = "Maximum"
      metrics = [
        ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { label = "rodando" }],
        ["ECS/ContainerInsights", "DesiredTaskCount", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { label = "desejadas" }],
      ]
      yAxis = { left = { min = 0 } }
    }
  }] : []

  running_tile = var.container_insights ? [
    ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { label = "Tasks rodando", stat = "Minimum" }],
    ] : [
    ["AWS/ECS", "CPUUtilization", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { label = "CPU ECS %", stat = "Average" }],
  ]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.name}-operacao"

  dashboard_body = jsonencode({
    start          = "-PT3H"
    periodOverride = "auto"
    widgets = concat([
      # ---- Linha 0: o sistema está bem? ----
      {
        type = "metric", width = 4, height = 4, x = 0, y = 0
        properties = {
          title   = "Latência do alerta p99 (ms) · SLO 500", region = var.region, view = "singleValue", period = 300, stat = "p99"
          metrics = [[local.dash.pipe, "AlertLatencyMs", { label = "p99" }]]
        }
      },
      {
        type = "metric", width = 4, height = 4, x = 4, y = 0
        properties = {
          title = "Entrada (TPS)", region = var.region, view = "singleValue", period = 60, stat = "Sum"
          metrics = [
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", local.dash.tx, { id = "s", visible = false }],
            [{ expression = "s/60", label = "eventos/s", id = "tps" }],
          ]
        }
      },
      {
        type = "metric", width = 4, height = 4, x = 8, y = 0
        properties = {
          title   = "Idade da msg mais antiga em transactions (s)", region = var.region, view = "singleValue", period = 60, stat = "Maximum"
          metrics = [["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", local.dash.tx, { label = "idade" }]]
        }
      },
      {
        type = "metric", width = 4, height = 4, x = 12, y = 0
        properties = {
          title   = "Mensagens nas DLQs", region = var.region, view = "singleValue", period = 60, stat = "Maximum"
          metrics = local.dlq_sum_metrics
        }
      },
      {
        type = "metric", width = 4, height = 4, x = 16, y = 0
        properties = {
          title   = var.container_insights ? "Tasks rodando" : "CPU do serviço ECS (%)", region = var.region, view = "singleValue", period = 60
          metrics = local.running_tile
        }
      },
      {
        type = "metric", width = 4, height = 4, x = 20, y = 0
        properties = {
          title   = "Alertas por minuto", region = var.region, view = "singleValue", period = 60, stat = "Sum"
          metrics = [[local.dash.rules, "AlertsCreated", { label = "alertas/min" }]]
        }
      },
      {
        type       = "alarm", width = 24, height = 3, x = 0, y = 4
        properties = { title = "Alarmes", alarms = local.dash_alarms }
      },

      # ---- Linha 1: vazão, latência e backlog ----
      {
        type = "metric", width = 8, height = 6, x = 0, y = 7
        properties = {
          title = "Vazão: entrada × consumo (eventos/s)", region = var.region, view = "timeSeries", period = 60, stat = "Sum"
          metrics = [
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", local.dash.tx, { id = "in", visible = false }],
            ["AWS/SQS", "NumberOfMessagesDeleted", "QueueName", local.dash.tx, { id = "out", visible = false }],
            [{ expression = "in/60", label = "entrada (SendMessage)", id = "tps_in" }],
            [{ expression = "out/60", label = "consumo (processados e removidos)", id = "tps_out" }],
          ]
          yAxis = { left = { min = 0, label = "eventos/s" } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 8, y = 7
        properties = {
          title = "Latência do alerta (ms): ingestedAt → aceite do SNS", region = var.region, view = "timeSeries", period = 60
          metrics = [
            [local.dash.pipe, "AlertLatencyMs", { stat = "p50", label = "p50" }],
            [local.dash.pipe, "AlertLatencyMs", { stat = "p95", label = "p95" }],
            [local.dash.pipe, "AlertLatencyMs", { stat = "p99", label = "p99" }],
          ]
          annotations = { horizontal = [{ label = "SLO 500 ms", value = 500, color = "#d62728" }] }
          yAxis       = { left = { min = 0, label = "ms" } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 16, y = 7
        properties = {
          title = "Backlog da fila transactions", region = var.region, view = "timeSeries", period = 60
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", local.dash.tx, { stat = "Maximum", label = "visíveis" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesNotVisible", "QueueName", local.dash.tx, { stat = "Maximum", label = "em voo" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", local.dash.tx, { stat = "Maximum", label = "idade da mais antiga (s)", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0 }, right = { min = 0, label = "s" } }
        }
      },

      # ---- Linha 2: o que acontece com os eventos ----
      {
        type = "metric", width = 8, height = 6, x = 0, y = 13
        properties = {
          title = "Eventos processados por resultado (por minuto)", region = var.region, view = "timeSeries", stacked = true, period = 60, stat = "Sum"
          metrics = [
            [local.dash.pipe, "EventsNoAlert", { label = "sem alerta" }],
            [local.dash.pipe, "EventsAlerted", { label = "alerta criado" }],
            [local.dash.pipe, "EventsDuplicate", { label = "duplicado" }],
            [local.dash.pipe, "EventsRejected", { label = "rejeitado (inválido)" }],
            [local.dash.pipe, "EventsTransientFailure", { label = "falha transitória (retry)" }],
          ]
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 8, y = 13
        properties = {
          title = "Alertas por minuto e faixa esperada", region = var.region, view = "timeSeries", period = 60
          metrics = [
            [local.dash.rules, "AlertsCreated", { id = "alerts", stat = "Sum", label = "alertas/min" }],
            [{ expression = "ANOMALY_DETECTION_BAND(alerts, 3)", label = "faixa esperada", id = "band" }],
          ]
          yAxis = { left = { min = 0 } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 16, y = 13
        properties = {
          title = "Teste de carga: TPS planejado × entrada (eventos/s)", region = var.region, view = "timeSeries", period = 60
          metrics = [
            [local.dash.lt, "PlannedTps", { id = "plan", stat = "Maximum", label = "planejado" }],
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", local.dash.tx, { id = "sent", stat = "Sum", visible = false }],
            [{ expression = "sent/60", label = "entrada real", id = "real" }],
            [local.dash.lt, "Phase", { id = "phase", stat = "Maximum", label = "fase (1 aquec. · 2 steady · 3 drain)", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0, label = "eventos/s" }, right = { min = 0, max = 4 } }
        }
      },

      # ---- Linha 3: entrega, outbox e DLQ ----
      {
        type = "metric", width = 8, height = 6, x = 0, y = 19
        properties = {
          title = "Outbox", region = var.region, view = "timeSeries", period = 60, stat = "Maximum"
          metrics = [
            [local.dash.pipe, "OutboxPending", { label = "pendentes" }],
            [local.dash.pipe, "OutboxOldestPendingAgeMs", { label = "idade do mais antigo (ms)", yAxis = "right" }],
            [local.dash.pipe, "OutboxPublishFailures", { stat = "Sum", label = "falhas de publicação/min" }],
            [local.dash.pipe, "OutboxRepublished", { stat = "Sum", label = "republicados pelo relay/min" }],
          ]
          yAxis = { left = { min = 0 }, right = { min = 0, label = "ms" } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 8, y = 19
        properties = {
          title = "Entregas por canal (por minuto) e idade das filas de canal", region = var.region, view = "timeSeries", period = 60
          metrics = concat(
            [
              [local.dash.pipe, "DeliveriesDelivered", { stat = "Sum", label = "entregues" }],
              [local.dash.pipe, "DeliveriesDeadLettered", { stat = "Sum", label = "esgotaram retries (DLQ)" }],
              [local.dash.pipe, "DeliveriesInfraFailure", { stat = "Sum", label = "falha de infraestrutura" }],
            ],
            [for q in local.dash.chan : ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", q, { stat = "Maximum", yAxis = "right", label = "idade ${q} (s)" }]],
          )
          yAxis = { left = { min = 0 }, right = { min = 0, label = "s" } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 16, y = 19
        properties = {
          title = "DLQs (mensagens visíveis) e mensagens enviadas a DLQ", region = var.region, view = "timeSeries", period = 60
          metrics = concat(
            [for q in local.dash.dlqs : ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", q, { stat = "Maximum" }]],
            [[local.dash.pipe, "DlqMessages", { stat = "Sum", label = "enviadas à DLQ/min", yAxis = "right" }]],
          )
          yAxis = { left = { min = 0 }, right = { min = 0 } }
        }
      },

      # ---- Linha 4: capacidade (por que algo saturou) ----
      {
        type = "metric", width = 8, height = 6, x = 0, y = 25
        properties = {
          title = "ECS: CPU e memória do serviço (%)", region = var.region, view = "timeSeries", period = 60
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { stat = "Average", label = "CPU média" }],
            ["AWS/ECS", "CPUUtilization", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { stat = "Maximum", label = "CPU máxima" }],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { stat = "Average", label = "memória média" }],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", local.dash.cluster, "ServiceName", local.dash.service, { stat = "Maximum", label = "memória máxima" }],
          ]
          annotations = { horizontal = [{ label = "alarme 85%", value = 85, color = "#d62728" }] }
          yAxis       = { left = { min = 0, max = 100 } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 16, y = 25
        properties = {
          title = "RDS: CPU e conexões", region = var.region, view = "timeSeries", period = 60, stat = "Average"
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", local.dash.db, { label = "CPU %" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", local.dash.db, { label = "conexões", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0, max = 100 }, right = { min = 0 } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 0, y = 31
        properties = {
          title = "RDS: escrita (IOPS e latência) e espaço livre", region = var.region, view = "timeSeries", period = 60, stat = "Average"
          metrics = [
            ["AWS/RDS", "WriteIOPS", "DBInstanceIdentifier", local.dash.db, { label = "WriteIOPS" }],
            ["AWS/RDS", "WriteLatency", "DBInstanceIdentifier", local.dash.db, { label = "latência de escrita (s)", yAxis = "right" }],
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", local.dash.db, { label = "espaço livre (bytes)", yAxis = "right", visible = false }],
          ]
          yAxis = { left = { min = 0 }, right = { min = 0 } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 8, y = 31
        properties = {
          title = "Redis: CPU e conexões", region = var.region, view = "timeSeries", period = 60, stat = "Average"
          metrics = [
            ["AWS/ElastiCache", "EngineCPUUtilization", "CacheClusterId", local.dash.redis, { label = "CPU do engine %" }],
            ["AWS/ElastiCache", "CurrConnections", "CacheClusterId", local.dash.redis, { label = "conexões", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0, max = 100 }, right = { min = 0 } }
        }
      },
      {
        type = "metric", width = 8, height = 6, x = 16, y = 31
        properties = {
          title = "Regras dinâmicas: revisão ativa e saúde do refresh", region = var.region, view = "timeSeries", period = 60
          metrics = [
            [local.dash.rules, "RulesActiveRevision", { stat = "Maximum", label = "revisão (máx.)" }],
            [local.dash.rules, "RulesActiveRevision", { stat = "Minimum", label = "revisão (mín.)" }],
            [local.dash.rules, "RulesLastRefreshAgeSeconds", { stat = "Maximum", label = "idade do último refresh (s)", yAxis = "right" }],
            [local.dash.rules, "RulesRefreshFailures", { stat = "Sum", label = "falhas de refresh/min", yAxis = "right" }],
          ]
          yAxis = { left = { showUnits = false }, right = { min = 0 } }
        }
      },
    ], local.tasks_widget)
  })
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
