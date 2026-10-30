variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "vpc_id" {
  description = "VPC do banco."
  type        = string
}

variable "subnet_ids" {
  description = "Sub-redes privadas de dados."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "SGs que alcançam a porta 5432 (nome lógico → id)."
  type        = map(string)
}

variable "kms_key_arn" {
  description = "CMK `rds` (armazenamento e Performance Insights)."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "CMK `secrets` (senha do usuário mestre no Secrets Manager)."
  type        = string
}

variable "engine_version" {
  description = "Versão do PostgreSQL (major 17 — DEC-050)."
  type        = string
  default     = "17"
}

variable "instance_class" {
  description = "Classe da instância."
  type        = string
}

variable "allocated_storage" {
  description = "Armazenamento inicial (GiB)."
  type        = number
  default     = 50
}

variable "max_allocated_storage" {
  description = "Teto do autoscaling de armazenamento (GiB)."
  type        = number
  default     = 500
}

variable "multi_az" {
  description = "Standby síncrono em outra AZ."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Retenção dos backups automáticos (dias)."
  type        = number
  default     = 35
}

variable "deletion_protection" {
  description = "Impede excluir a instância."
  type        = bool
  default     = true
}
