locals {
  image         = "${aws_ecr_repository.app.repository_url}:${var.image_tag == "" ? "none" : var.image_tag}"
  has_image     = var.image_tag != ""
  start         = local.has_image && var.start_service
  desired_count = local.start ? var.service_desired_count : 0
  min_count     = local.start ? var.service_min_count : 0
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = local.kms_key_arn
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${var.name}-migrate"
  retention_in_days = var.log_retention_days
  kms_key_id        = local.kms_key_arn
}

resource "aws_ecs_cluster" "main" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

locals {
  app_environment = {
    NODE_ENV                    = "production"
    PORT                        = "3000"
    AWS_REGION                  = var.region
    SQS_TRANSACTIONS_QUEUE      = aws_sqs_queue.transactions.name
    SQS_TRANSACTIONS_DLQ        = aws_sqs_queue.transactions_dlq.name
    SQS_CHANNEL_ANTIFRAUD_QUEUE = aws_sqs_queue.channel["antifraud"].name
    SQS_CHANNEL_CUSTOMER_QUEUE  = aws_sqs_queue.channel["customer"].name
    SQS_CHANNEL_ANTIFRAUD_DLQ   = aws_sqs_queue.channel_dlq["antifraud"].name
    SQS_CHANNEL_CUSTOMER_DLQ    = aws_sqs_queue.channel_dlq["customer"].name
    SNS_ALERTS_TOPIC            = aws_sns_topic.alerts.name
    SNS_ALERTS_TOPIC_ARN        = aws_sns_topic.alerts.arn
    RULES_CONFIG_PATH           = "config/rules.json"
    CONSUMERS_ENABLED           = "true"
    CHANNEL_CONSUMERS_ENABLED   = "true"
    SQS_TRANSACTION_POLLERS     = tostring(var.sqs_transaction_pollers)
    SQS_CHANNEL_POLLERS         = tostring(var.sqs_channel_pollers)
    CHANNEL_ANTIFRAUD_FAIL      = "false"
    CHANNEL_CUSTOMER_FAIL       = "false"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name                   = "app"
    image                  = local.image
    essential              = true
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
    environment            = [for k, v in local.app_environment : { name = k, value = v }]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O /dev/null http://localhost:3000/health/live || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    stopTimeout = 30
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

# Task one-off: mesma imagem, comando de migração. Executar com `aws ecs run-task` (ver README).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migrate.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name                   = "migrate"
    image                  = local.image
    essential              = true
    readonlyRootFilesystem = true
    command                = ["node", "dist/database/migrate.js"]
    secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migrate.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name                               = var.name
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = local.desired_count
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = false

  dynamic "capacity_provider_strategy" {
    for_each = { for k, v in {
      FARGATE      = { base = var.fargate_base, weight = var.fargate_weight }
      FARGATE_SPOT = { base = 0, weight = var.fargate_spot_weight }
    } : k => v if v.weight > 0 || v.base > 0 }
    content {
      capacity_provider = capacity_provider_strategy.key
      base              = capacity_provider_strategy.value.base
      weight            = capacity_provider_strategy.value.weight
    }
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_ecs_cluster_capacity_providers.main]

  # O autoscaling altera desired_count entre applies.
  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "app" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  min_capacity       = local.min_count
  max_capacity       = max(var.service_max_count, local.min_count)
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.app.service_namespace
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension
  resource_id        = aws_appautoscaling_target.app.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---------- Gerador de carga (opcional) ----------
resource "aws_cloudwatch_log_group" "loadtest" {
  count             = var.enable_loadtest ? 1 : 0
  name              = "/ecs/${var.name}-loadtest"
  retention_in_days = var.log_retention_days
  kms_key_id        = local.kms_key_arn
}

resource "aws_ecs_task_definition" "loadtest" {
  count                    = var.enable_loadtest ? 1 : 0
  family                   = "${var.name}-loadtest"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.loadtest[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name      = "loadtest"
    image     = var.loadtest_image
    essential = true
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "SNS_ALERTS_TOPIC_ARN", value = aws_sns_topic.alerts.arn },
      { name = "SQS_TRANSACTIONS_QUEUE", value = aws_sqs_queue.transactions.name },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.loadtest[0].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "loadtest"
      }
    }
  }])
}
