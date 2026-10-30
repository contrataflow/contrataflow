variable "environment" {
  description = "Ambiente lógico: `staging` ou `production` (APP_ENV)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Só staging e production rodam na AWS (dev segue no Compose da US-078)."
  }
}

# --- Identificadores do ambiente (terraform.tfvars da raiz) ---------------------------------------

variable "hosted_zone_name" {
  description = "Zona pública do Route 53 (ex.: contrataflow.com.br)."
  type        = string
}

variable "app_hostname" {
  description = "Host público do web (app.<domínio>) — STAGING_URL/PRODUCTION_URL."
  type        = string
}

variable "email_domain" {
  description = "Domínio de envio de e-mail (SES)."
  type        = string
}

variable "email_from" {
  description = "Remetente (EMAIL_FROM), no domínio de envio."
  type        = string
}

variable "oidc_issuer_url" {
  description = "Issuer do provider Authentik (`…/application/o/<slug>/`)."
  type        = string
}

variable "oidc_client_id" {
  description = "Cliente confidencial do BFF."
  type        = string
  default     = "contrataflow-web"
}

variable "oidc_audience" {
  description = "Audiência aceita pela API."
  type        = string
  default     = "contrataflow-web"
}

variable "authentik_api_url" {
  description = "API de administração do Authentik."
  type        = string
}

variable "otlp_endpoint" {
  description = "Endpoint OTLP do backend de telemetria (obrigatório em staging/produção)."
  type        = string
}

variable "traces_query_url" {
  description = "Consulta de traces do backend (API do Tempo) — TRACES_QUERY_URL do estágio 8."
  type        = string
}

variable "alarm_emails" {
  description = "E-mails do plantão para os alarmes."
  type        = list(string)
  default     = []
}

# --- Imagens --------------------------------------------------------------------------------------

variable "create_ecr" {
  description = "Cria os repositórios ECR nesta conta (staging). Produção puxa do registry de staging."
  type        = bool
}

variable "ecr_registry" {
  description = "Registry de onde as imagens vêm quando `create_ecr = false`."
  type        = string
  default     = ""
}

variable "ecr_pull_account_ids" {
  description = "Contas que podem puxar do ECR desta conta (a de produção)."
  type        = list(string)
  default     = []
}

variable "gotenberg_version" {
  description = "Tag do espelho do Gotenberg no ECR (mesma versão do Compose)."
  type        = string
  default     = "8.37.0"
}

variable "clamav_version" {
  description = "Tag do espelho do ClamAV no ECR (mesma versão do Compose)."
  type        = string
  default     = "1.5.4"
}

variable "migrator_command" {
  description = "Comando da task de migração (`prisma migrate deploy` com o papel cf_migrator)."
  type        = list(string)
  default     = ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
}

variable "app_secret_keys" {
  description = "Chaves do JSON `contrataflow/<env>/app` (valores pelo roteiro de bootstrap)."
  type        = list(string)
  default = [
    "AUTHENTIK_API_TOKEN",
    "BLIND_INDEX_KEY",
    "DATABASE_MIGRATION_URL",
    "DATABASE_URL_APP",
    "DATABASE_URL_MAINTENANCE",
    "DATABASE_URL_PLATFORM",
    "DATABASE_URL_RELAY",
    "DATABASE_URL_WORKER",
    "FIELD_ENCRYPTION_KEY",
    "INTERNAL_SERVICE_TOKEN",
    "OIDC_CLIENT_SECRET",
    "SESSION_ENCRYPTION_KEY",
  ]
}

# --- Tamanho e redundância ------------------------------------------------------------------------

variable "availability_zones" {
  description = "Três AZs de sa-east-1."
  type        = list(string)
  default     = ["sa-east-1a", "sa-east-1b", "sa-east-1c"]
}

variable "vpc_cidr_block" {
  description = "Bloco /16 da VPC."
  type        = string
}

variable "nat_gateway_per_az" {
  description = "Um NAT por AZ."
  type        = bool
  default     = true
}

variable "rds_instance_class" {
  description = "Classe do RDS."
  type        = string
}

variable "rds_allocated_storage" {
  description = "Armazenamento inicial do RDS (GiB)."
  type        = number
  default     = 50
}

variable "rds_multi_az" {
  description = "RDS Multi-AZ."
  type        = bool
  default     = true
}

variable "rds_backup_retention_days" {
  description = "Retenção dos backups do RDS."
  type        = number
  default     = 35
}

variable "redis_node_type" {
  description = "Tipo dos nós do ElastiCache."
  type        = string
}

variable "redis_nodes" {
  description = "Nós por replication group (≥ 2 = failover Multi-AZ)."
  type        = number
  default     = 2
}

variable "services" {
  description = "CPU, memória e faixa de tasks de api, web e worker."
  type = object({
    api    = object({ cpu = number, memory = number, min = number, max = number })
    web    = object({ cpu = number, memory = number, min = number, max = number })
    worker = object({ cpu = number, memory = number, min = number, max = number })
  })
}

variable "deletion_protection" {
  description = "Proteção contra exclusão (RDS e ALB)."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Retenção dos logs no CloudWatch."
  type        = number
  default     = 365
}
