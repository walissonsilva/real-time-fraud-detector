locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# Segurança: o SG default da VPC não permite nada.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = var.name }
}

# /20 por subnet: public 0-1, private 4-5, isolated 8-9
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 4 + count.index)
  tags              = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_subnet" "isolated" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 8 + count.index)
  tags              = { Name = "${var.name}-isolated-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.enable_nat ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  count         = var.enable_nat ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = var.name }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-private" }
}

resource "aws_route" "private_nat" {
  count                  = var.enable_nat ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Subnets isoladas (RDS/Redis): sem rota para fora da VPC.
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-isolated" }
}

resource "aws_route_table_association" "isolated" {
  count          = 2
  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

# ---------- Security groups ----------
resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "Tasks ECS da aplicacao (sem ingress)"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-app" }
}

resource "aws_security_group" "migrate" {
  name        = "${var.name}-migrate"
  description = "Task de migration"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-migrate" }
}

resource "aws_security_group" "loadtest" {
  count       = var.enable_loadtest ? 1 : 0
  name        = "${var.name}-loadtest"
  description = "Gerador de carga"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-loadtest" }
}

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds"
  description = "PostgreSQL"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-rds" }
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-redis" }
}

resource "aws_security_group" "vpce" {
  count       = var.enable_vpc_endpoints ? 1 : 0
  name        = "${var.name}-vpce"
  description = "VPC endpoints de interface"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-vpce" }
}

locals {
  # SGs que acessam serviços AWS (HTTPS) e/ou o banco
  aws_clients = merge(
    { app = aws_security_group.app.id, migrate = aws_security_group.migrate.id },
    var.enable_loadtest ? { loadtest = aws_security_group.loadtest[0].id } : {},
  )
}

# Saída HTTPS: internet via NAT (lean) ou VPC endpoints + prefix list do S3 (full)
resource "aws_vpc_security_group_egress_rule" "https_internet" {
  for_each          = var.enable_nat ? local.aws_clients : {}
  security_group_id = each.value
  description       = "HTTPS via NAT"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "https_vpce" {
  for_each                     = var.enable_vpc_endpoints ? local.aws_clients : {}
  security_group_id            = each.value
  description                  = "HTTPS para VPC endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.vpce[0].id
}

resource "aws_vpc_security_group_egress_rule" "https_s3" {
  for_each          = var.enable_vpc_endpoints ? local.aws_clients : {}
  security_group_id = each.value
  description       = "HTTPS para S3 (camadas do ECR)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_vpc_endpoint.s3[0].prefix_list_id
}

resource "aws_vpc_security_group_ingress_rule" "vpce_https" {
  for_each                     = var.enable_vpc_endpoints ? local.aws_clients : {}
  security_group_id            = aws_security_group.vpce[0].id
  description                  = "HTTPS dos clientes"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = each.value
}

# app/migrate -> RDS ; app -> Redis
resource "aws_vpc_security_group_egress_rule" "to_rds" {
  for_each                     = { app = aws_security_group.app.id, migrate = aws_security_group.migrate.id }
  security_group_id            = each.value
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

resource "aws_vpc_security_group_ingress_rule" "rds_from" {
  for_each                     = { app = aws_security_group.app.id, migrate = aws_security_group.migrate.id }
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL de ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_vpc_security_group_egress_rule" "app_to_redis" {
  security_group_id            = aws_security_group.app.id
  description                  = "Redis"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.redis.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis da app"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.app.id
}

# ---------- VPC endpoints (full) ----------
locals {
  interface_endpoints = var.enable_vpc_endpoints ? toset(["sqs", "sns", "ecr.api", "ecr.dkr", "logs", "secretsmanager"]) : toset([])
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpce[0].id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-${each.key}" }
}

resource "aws_vpc_endpoint" "kms" {
  count               = var.enable_vpc_endpoints && var.enable_cmk ? 1 : 0
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.kms"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpce[0].id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-kms" }
}

resource "aws_vpc_endpoint" "s3" {
  count             = var.enable_vpc_endpoints ? 1 : 0
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${var.name}-s3" }
}

# ---------- Flow logs ----------
resource "aws_cloudwatch_log_group" "flow" {
  name              = "/vpc/${var.name}/flow-logs"
  retention_in_days = var.log_retention_days
  kms_key_id        = local.kms_key_arn
}

data "aws_iam_policy_document" "flow_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow" {
  name               = "${var.name}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_assume.json
}

data "aws_iam_policy_document" "flow" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow" {
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.flow.json
}

resource "aws_flow_log" "main" {
  vpc_id          = aws_vpc.main.id
  traffic_type    = var.flow_logs_traffic_type
  log_destination = aws_cloudwatch_log_group.flow.arn
  iam_role_arn    = aws_iam_role.flow.arn
}
