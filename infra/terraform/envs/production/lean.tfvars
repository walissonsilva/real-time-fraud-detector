# Perfil lean: mínimo de recursos para o teste de 8k TPS.
profile = "lean"

enable_nat             = true
enable_vpc_endpoints   = false
flow_logs_traffic_type = "REJECT"
log_retention_days     = 14

ephemeral = true

enable_cmk        = false
enable_guardduty  = false
enable_cloudtrail = true

db_instance_class        = "db.t4g.medium"
db_multi_az              = false
db_backup_retention_days = 7
db_deletion_protection   = false
db_performance_insights  = false
redis_node_type          = "cache.t4g.micro"
redis_num_nodes          = 1

task_cpu              = 1024
task_memory           = 2048
service_desired_count = 3
service_min_count     = 3
service_max_count     = 6
fargate_base          = 0
fargate_weight        = 0
fargate_spot_weight   = 1
container_insights    = false

monthly_budget_usd = 150
# alert_email = "voce@example.com"  # defina em um arquivo *.auto.tfvars local (gitignored) ou via -var
