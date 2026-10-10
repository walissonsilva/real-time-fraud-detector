# Gerador de carga k6 em EC2 (docs/teste-de-carga-aws-runner-ec2.md): criado e destruído a cada rodada pelo
# loadtest.sh. O comando docker run chega por SSM Run Command (sem SSH, sem porta aberta).
locals {
  loadtest_ec2_enabled = var.enable_loadtest && var.enable_loadtest_ec2
  loadtest_instance_type = var.loadtest_instance_type != "" ? var.loadtest_instance_type : (
    var.cpu_architecture == "ARM64" ? "c7g.xlarge" : "c6i.xlarge"
  )
  loadtest_ami_param = var.cpu_architecture == "ARM64" ? "al2023-ami-kernel-default-arm64" : "al2023-ami-kernel-default-x86_64"
}

data "aws_ssm_parameter" "loadtest_ami" {
  count = local.loadtest_ec2_enabled ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/${local.loadtest_ami_param}"
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "loadtest_ec2" {
  count              = local.loadtest_ec2_enabled ? 1 : 0
  name               = "${var.name}-loadtest-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Mesmas permissões do gerador em Fargate (enviar transações, ler o sink, KMS).
resource "aws_iam_role_policy" "loadtest_ec2" {
  count  = local.loadtest_ec2_enabled ? 1 : 0
  role   = aws_iam_role.loadtest_ec2[0].id
  policy = data.aws_iam_policy_document.loadtest[0].json
}

data "aws_iam_policy_document" "loadtest_ec2_logs" {
  count = local.loadtest_ec2_enabled ? 1 : 0
  statement {
    sid       = "WriteLoadtestLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.loadtest[0].arn}:*"]
  }
}

resource "aws_iam_role_policy" "loadtest_ec2_logs" {
  count  = local.loadtest_ec2_enabled ? 1 : 0
  name   = "logs"
  role   = aws_iam_role.loadtest_ec2[0].id
  policy = data.aws_iam_policy_document.loadtest_ec2_logs[0].json
}

resource "aws_iam_role_policy_attachment" "loadtest_ec2_ssm" {
  count      = local.loadtest_ec2_enabled ? 1 : 0
  role       = aws_iam_role.loadtest_ec2[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "loadtest_ec2_ecr" {
  count      = local.loadtest_ec2_enabled ? 1 : 0
  role       = aws_iam_role.loadtest_ec2[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_instance_profile" "loadtest" {
  count = local.loadtest_ec2_enabled ? 1 : 0
  name  = "${var.name}-loadtest-ec2"
  role  = aws_iam_role.loadtest_ec2[0].name
}

resource "aws_instance" "loadtest" {
  count                  = local.loadtest_ec2_enabled ? 1 : 0
  ami                    = nonsensitive(data.aws_ssm_parameter.loadtest_ami[0].value)
  instance_type          = local.loadtest_instance_type
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.loadtest[0].id]
  iam_instance_profile   = aws_iam_instance_profile.loadtest[0].name
  monitoring             = true # métricas de 1 min (CPU do gerador no relatório)

  dynamic "instance_market_options" {
    for_each = var.loadtest_use_spot ? [1] : []
    content {
      market_type = "spot"
      spot_options {
        spot_instance_type             = "one-time"
        instance_interruption_behavior = "terminate"
      }
    }
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # containers acessam o IMDS (credenciais do awslogs e do aws cli)
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  user_data = <<-EOT
    #!/bin/bash
    dnf install -y docker
    systemctl enable --now docker
  EOT

  user_data_replace_on_change = true

  tags = { Name = "${var.name}-loadtest" }
}
