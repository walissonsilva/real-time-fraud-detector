variable "region" {
  type    = string
  default = "us-east-1"
}

variable "profile" {
  description = "Rótulo do perfil de custo (lean | full); os valores vêm do .tfvars correspondente."
  type        = string
  validation {
    condition     = contains(["lean", "full"], var.profile)
    error_message = "profile deve ser lean ou full."
  }
}

variable "name" {
  type    = string
  default = "fraud-detector"
}

# ---------- Rede ----------
variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}
variable "enable_nat" {
  description = "NAT Gateway para saída à internet (lean). No full, usa VPC endpoints."
  type        = bool
}
variable "enable_vpc_endpoints" {
  type = bool
}
variable "flow_logs_traffic_type" {
  description = "ALL ou REJECT"
  type        = string
}
variable "log_retention_days" {
  type = number
}

variable "ephemeral" {
  description = "Ambiente descartável (lean): secrets sem janela de recuperação, sem snapshot final do RDS e ECR com force_delete, para permitir destroy + recriação."
  type        = bool
}
variable "start_service" {
  description = "false mantém o serviço ECS em 0 tasks mesmo com image_tag (usado pelo up.sh para migrar antes de subir)."
  type        = bool
  default     = true
}

# ---------- Segurança ----------
variable "enable_cmk" {
  description = "CMK dedicada (full). Se false: SSE-SQS e chaves gerenciadas pela AWS."
  type        = bool
}
variable "enable_guardduty" {
  type    = bool
  default = false
}
variable "enable_cloudtrail" {
  type    = bool
  default = true
}
variable "transaction_producer_principals" {
  description = "ARNs (roles/contas) autorizados a enviar para a fila transactions."
  type        = list(string)
  default     = []
}

# ---------- Banco / cache ----------
variable "db_instance_class" {
  type = string
}
variable "db_multi_az" {
  type = bool
}
variable "db_allocated_storage" {
  type    = number
  default = 50
}
variable "db_backup_retention_days" {
  type = number
}
variable "db_deletion_protection" {
  type = bool
}
variable "db_performance_insights" {
  type = bool
}
variable "redis_node_type" {
  type = string
}
variable "redis_num_nodes" {
  type = number
}

# ---------- ECS ----------
variable "image_tag" {
  description = "Tag imutável da imagem no ECR. Vazio = serviço criado com desired_count 0 até existir imagem."
  type        = string
  default     = ""
}
variable "cpu_architecture" {
  description = "X86_64 (padrão; buildável nesta máquina) ou ARM64 (~20% mais barato, exige build arm64: qemu/runner ARM). A imagem enviada ao ECR precisa ser da mesma arquitetura."
  type        = string
  default     = "X86_64"
}
variable "task_cpu" {
  type    = number
  default = 1024
}
variable "task_memory" {
  type    = number
  default = 2048
}
variable "service_desired_count" {
  type = number
}
variable "service_min_count" {
  type = number
}
variable "service_max_count" {
  type = number
}
variable "fargate_base" {
  description = "Tasks mínimas em FARGATE on-demand"
  type        = number
}
variable "fargate_weight" {
  type = number
}
variable "fargate_spot_weight" {
  type = number
}
variable "container_insights" {
  type = bool
}
variable "sqs_transaction_pollers" {
  type    = number
  default = 4
}
variable "sqs_channel_pollers" {
  type    = number
  default = 2
}

# ---------- Observabilidade / custo ----------
variable "alert_email" {
  description = "E-mail para alarmes e orçamento (a assinatura precisa ser confirmada)."
  type        = string
}
variable "monthly_budget_usd" {
  type = number
}

# ---------- Teste de carga ----------
variable "enable_loadtest" {
  type    = bool
  default = false
}
variable "loadtest_image" {
  description = "Imagem do gerador de carga (precisa de acesso: Docker Hub exige NAT; ECR funciona com endpoints)."
  type        = string
  default     = "grafana/k6:0.55.0"
}
