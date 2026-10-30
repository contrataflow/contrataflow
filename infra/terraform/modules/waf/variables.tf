variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "alb_arn" {
  description = "ALB protegido."
  type        = string
}

variable "rate_limit_per_5_minutes" {
  description = "Requisições por IP em 5 minutos antes do bloqueio."
  type        = number
  default     = 2000
}

variable "logs_kms_key_arn" {
  description = "CMK de logs."
  type        = string
}

variable "log_retention_days" {
  description = "Retenção dos logs do WAF."
  type        = number
  default     = 90
}
