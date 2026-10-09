# ---------- RDS PostgreSQL ----------
resource "random_password" "db" {
  length  = 32
  special = false # evita escape na DATABASE_URL
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.isolated[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.name}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${var.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "main" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  db_name  = "fraud"
  username = "fraud"
  password = random_password.db.result

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 4
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = local.kms_key_arn

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period   = var.db_backup_retention_days
  copy_tags_to_snapshot     = true
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.ephemeral
  final_snapshot_identifier = var.ephemeral ? null : "${var.name}-final"

  auto_minor_version_upgrade          = true
  performance_insights_enabled        = var.db_performance_insights
  performance_insights_kms_key_id     = var.db_performance_insights ? local.kms_key_arn : null
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  iam_database_authentication_enabled = false
  apply_immediately                   = true
}

# ---------- ElastiCache Redis ----------
resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.isolated[*].id
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = var.name
  description          = "${var.name} redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  port                 = 6379

  num_cache_clusters         = var.redis_num_nodes
  automatic_failover_enabled = var.redis_num_nodes > 1
  multi_az_enabled           = var.redis_num_nodes > 1

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = local.kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result

  apply_immediately = true
}

# ---------- Secrets Manager (injetados no ECS pela execution role) ----------
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "fraud/prod/database-url"
  kms_key_id              = local.kms_key_arn
  recovery_window_in_days = var.ephemeral ? 0 : 7
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  # sslmode=verify-full valida o certificado: a imagem inclui o bundle de CAs do RDS (NODE_EXTRA_CA_CERTS).
  secret_string = "postgres://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${aws_db_instance.main.db_name}?sslmode=verify-full"
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "fraud/prod/redis-url"
  kms_key_id              = local.kms_key_arn
  recovery_window_in_days = var.ephemeral ? 0 : 7
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
}
