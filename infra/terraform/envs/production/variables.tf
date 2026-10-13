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
  description = "Imagem completa do gerador de carga. Vazio usa o repositório ECR do teste (aws_ecr_repository.loadtest) com loadtest_image_tag."
  type        = string
  default     = ""
}
variable "loadtest_image_tag" {
  description = "Tag da imagem do k6 no ECR (definida pelo loadtest.sh)."
  type        = string
  default     = "none"
}
variable "loadtest_cpu" {
  description = "CPU da task do k6. Comece com 2048; suba para 4096 se o gerador saturar (dropped_iterations > 0)."
  type        = number
  default     = 2048
}
variable "loadtest_memory" {
  description = "Memória (MiB) da task do k6; 4096 para 2 vCPU, 8192 para 4 vCPU."
  type        = number
  default     = 4096
}

# ---------- Gerador k6 em EC2 (docs/teste-de-carga-aws-runner-ec2.md) ----------
variable "enable_loadtest_ec2" {
  description = "Cria a instância EC2 do k6 (exige enable_loadtest). Usado por loadtest.sh --runner ec2."
  type        = bool
  default     = false
}
variable "loadtest_instance_type" {
  description = "Tipo da instância do k6. Vazio: c6i.xlarge (X86_64) ou c7g.xlarge (ARM64), conforme cpu_architecture."
  type        = string
  default     = ""
}
variable "loadtest_use_spot" {
  description = "Instância Spot de requisição única (false = On-Demand, fallback quando falta capacidade Spot)."
  type        = bool
  default     = true
}

variable "rules_divergence_minutes" {
  description = "Tempo com instâncias em revisões de regras diferentes antes de alarmar (maior que rollout + bake da estratégia gradual: 10 + 5 min)"
  type        = number
  default     = 20
}

variable "rules_operator_principals" {
  description = "ARNs (usuários, papéis ou SSO) autorizados a assumir o papel de operador de fraude, que publica, reverte e para deployments de regras. Vazio = papel não é criado (a política gerenciada continua disponível para anexar)."
  type        = list(string)
  default     = []
}

variable "alert_latency_slo_ms" {
  type        = number
  default     = 500
  description = "Limite do p99 da latência do alerta (RNF-03); acima dele, por 2 janelas de 5 min, o alarme dispara."
}

variable "outbox_pending_max_age_s" {
  type        = number
  default     = 30
  description = "Idade máxima, em segundos, de uma entrada pendente no outbox antes do alarme."
}
