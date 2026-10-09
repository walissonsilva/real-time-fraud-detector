data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# ---------- R1: execution role (pull de imagem, logs, injeção de secrets) ----------
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "ReadAppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.database_url.arn, aws_secretsmanager_secret.redis_url.arn]
  }

  dynamic "statement" {
    for_each = var.enable_cmk ? [1] : []
    content {
      sid       = "DecryptSecrets"
      actions   = ["kms:Decrypt"]
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# ---------- R2: task role da aplicação ----------
resource "aws_iam_role" "app" {
  name               = "${var.name}-app"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

locals {
  consume_queue_arns = concat([aws_sqs_queue.transactions.arn], [for q in aws_sqs_queue.channel : q.arn])
  dlq_arns           = concat([aws_sqs_queue.transactions_dlq.arn], [for q in aws_sqs_queue.channel_dlq : q.arn])
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ConsumeQueues"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
    resources = local.consume_queue_arns
  }

  statement {
    sid       = "WriteDlqs"
    actions   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
    resources = local.dlq_arns
  }

  statement {
    sid       = "PublishAlerts"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }

  dynamic "statement" {
    for_each = var.enable_cmk ? [1] : []
    content {
      sid       = "UseCmkForMessaging"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

# ---------- R3: task de migration (sem permissões AWS; só rede até o RDS) ----------
resource "aws_iam_role" "migrate" {
  name               = "${var.name}-migrate"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# ---------- Gerador de carga (opcional) ----------
resource "aws_iam_role" "loadtest" {
  count              = var.enable_loadtest ? 1 : 0
  name               = "${var.name}-loadtest"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "loadtest" {
  count = var.enable_loadtest ? 1 : 0

  statement {
    sid       = "SendTransactions"
    actions   = ["sqs:SendMessage", "sqs:GetQueueUrl"]
    resources = [aws_sqs_queue.transactions.arn]
  }

  statement {
    sid = "ManageSinkQueues"
    actions = [
      "sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:SetQueueAttributes",
      "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:PurgeQueue",
    ]
    resources = ["arn:${local.partition}:sqs:${var.region}:${local.account_id}:alerts-loadtest*"]
  }

  statement {
    sid       = "SubscribeSink"
    actions   = ["sns:Subscribe", "sns:Unsubscribe", "sns:GetTopicAttributes"]
    resources = [aws_sns_topic.alerts.arn]
  }

  dynamic "statement" {
    for_each = var.enable_cmk ? [1] : []
    content {
      sid       = "UseCmk"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_role_policy" "loadtest" {
  count  = var.enable_loadtest ? 1 : 0
  role   = aws_iam_role.loadtest[0].id
  policy = data.aws_iam_policy_document.loadtest[0].json
}
