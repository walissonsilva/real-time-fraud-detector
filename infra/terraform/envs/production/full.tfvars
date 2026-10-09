# Perfil full: suporte a testes de carga de até 25k TPS.
profile = "full"

enable_nat             = false
enable_vpc_endpoints   = true
flow_logs_traffic_type = "ALL"
log_retention_days     = 90

ephemeral = false

enable_cmk        = true
enable_guardduty  = true
enable_cloudtrail = true

db_instance_class        = "db.m6g.xlarge"
db_multi_az              = true
db_backup_retention_days = 14
db_deletion_protection   = true
db_performance_insights  = true
redis_node_type          = "cache.t4g.small"
redis_num_nodes          = 2

task_cpu              = 1024
task_memory           = 2048
service_desired_count = 8
service_min_count     = 8
service_max_count     = 20
fargate_base          = 4
fargate_weight        = 1
fargate_spot_weight   = 1
container_insights    = true

monthly_budget_usd = 800
# alert_email = "voce@example.com"
