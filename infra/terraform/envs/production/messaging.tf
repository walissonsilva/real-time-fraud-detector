# Topologia espelhando infra/localstack/init-aws.sh, com criptografia, high-throughput FIFO e policies.
locals {
  channels = {
    antifraud = "alert-deliveries-antifraud-queue"
    customer  = "alert-deliveries-customer-push"
  }

  sqs_encryption = var.enable_cmk ? {
    kms_master_key_id                 = aws_kms_key.main[0].arn
    kms_data_key_reuse_period_seconds = 300
    sqs_managed_sse_enabled           = null
    } : {
    kms_master_key_id                 = null
    kms_data_key_reuse_period_seconds = null
    sqs_managed_sse_enabled           = true
  }
}

# ---------- Standard: transactions ----------
resource "aws_sqs_queue" "transactions_dlq" {
  name                              = "transactions-dlq"
  message_retention_seconds         = 1209600
  kms_master_key_id                 = local.sqs_encryption.kms_master_key_id
  kms_data_key_reuse_period_seconds = local.sqs_encryption.kms_data_key_reuse_period_seconds
  sqs_managed_sse_enabled           = local.sqs_encryption.sqs_managed_sse_enabled
}

resource "aws_sqs_queue" "transactions" {
  name = "transactions"
  # Acoplado ao código (retries com ChangeMessageVisibility): manter 10 s.
  visibility_timeout_seconds        = 10
  kms_master_key_id                 = local.sqs_encryption.kms_master_key_id
  kms_data_key_reuse_period_seconds = local.sqs_encryption.kms_data_key_reuse_period_seconds
  sqs_managed_sse_enabled           = local.sqs_encryption.sqs_managed_sse_enabled
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.transactions_dlq.arn
    maxReceiveCount     = 10
  })
}

# ---------- SNS FIFO alerts.fifo (high-throughput por message group) ----------
resource "aws_sns_topic" "alerts" {
  name                        = "alerts.fifo"
  fifo_topic                  = true
  content_based_deduplication = false
  fifo_throughput_scope       = "MessageGroup"
  kms_master_key_id           = var.enable_cmk ? aws_kms_key.main[0].arn : "alias/aws/sns"
}

# ---------- SQS FIFO por canal e DLQs (high-throughput) ----------
resource "aws_sqs_queue" "channel_dlq" {
  for_each                          = local.channels
  name                              = "${each.value}-dlq.fifo"
  fifo_queue                        = true
  content_based_deduplication       = false
  deduplication_scope               = "messageGroup"
  fifo_throughput_limit             = "perMessageGroupId"
  message_retention_seconds         = 1209600
  kms_master_key_id                 = local.sqs_encryption.kms_master_key_id
  kms_data_key_reuse_period_seconds = local.sqs_encryption.kms_data_key_reuse_period_seconds
  sqs_managed_sse_enabled           = local.sqs_encryption.sqs_managed_sse_enabled
}

resource "aws_sqs_queue" "channel" {
  for_each                          = local.channels
  name                              = "${each.value}.fifo"
  fifo_queue                        = true
  content_based_deduplication       = false
  deduplication_scope               = "messageGroup"
  fifo_throughput_limit             = "perMessageGroupId"
  visibility_timeout_seconds        = 30
  kms_master_key_id                 = local.sqs_encryption.kms_master_key_id
  kms_data_key_reuse_period_seconds = local.sqs_encryption.kms_data_key_reuse_period_seconds
  sqs_managed_sse_enabled           = local.sqs_encryption.sqs_managed_sse_enabled
  # Sem redrive nativo: o app escreve DlqMessage nas DLQs (igual ao init-aws.sh).
}

resource "aws_sns_topic_subscription" "channel" {
  for_each             = local.channels
  topic_arn            = aws_sns_topic.alerts.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.channel[each.key].arn
  raw_message_delivery = true
}

# ---------- Queue policies ----------
locals {
  all_queues = merge(
    {
      transactions     = aws_sqs_queue.transactions
      transactions_dlq = aws_sqs_queue.transactions_dlq
    },
    { for k, q in aws_sqs_queue.channel : "channel_${k}" => q },
    { for k, q in aws_sqs_queue.channel_dlq : "channel_${k}_dlq" => q },
  )
  producers = concat(
    var.transaction_producer_principals,
    var.enable_loadtest ? [aws_iam_role.loadtest[0].arn] : [],
  )
}

data "aws_iam_policy_document" "queue" {
  for_each = local.all_queues

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value.arn]
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

  # Somente o tópico alerts.fifo pode entregar nas filas de canal.
  dynamic "statement" {
    for_each = startswith(each.key, "channel_") && !endswith(each.key, "_dlq") ? [1] : []
    content {
      sid       = "AllowAlertsTopic"
      actions   = ["sqs:SendMessage"]
      resources = [each.value.arn]
      principals {
        type        = "Service"
        identifiers = ["sns.amazonaws.com"]
      }
      condition {
        test     = "ArnEquals"
        variable = "aws:SourceArn"
        values   = [aws_sns_topic.alerts.arn]
      }
    }
  }

  # Produtores autorizados a enviar transações.
  dynamic "statement" {
    for_each = each.key == "transactions" && length(local.producers) > 0 ? [1] : []
    content {
      sid       = "AllowProducers"
      actions   = ["sqs:SendMessage"]
      resources = [each.value.arn]
      principals {
        type        = "AWS"
        identifiers = local.producers
      }
    }
  }
}

resource "aws_sqs_queue_policy" "queue" {
  for_each  = local.all_queues
  queue_url = each.value.url
  policy    = data.aws_iam_policy_document.queue[each.key].json
}
