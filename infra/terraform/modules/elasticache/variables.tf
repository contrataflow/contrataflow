variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "purpose" {
  description = "Finalidade do cluster: `sessions` (sessões — DEC-131) ou `main` (filas, idempotência, cache)."
  type        = string
}

variable "vpc_id" {
  description = "VPC do cluster."
  type        = string
}

variable "subnet_ids" {
  description = "Sub-redes privadas de dados."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "SGs que alcançam a porta 6379 (nome lógico → id)."
  type        = map(string)
}

variable "kms_key_arn" {
  description = "CMK da cifragem em repouso."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "CMK `secrets` (segredo com a URL)."
  type        = string
}

variable "engine_version" {
  description = "Versão do Redis OSS."
  type        = string
  default     = "7.1"
}

variable "node_type" {
  description = "Tipo dos nós."
  type        = string
}

variable "num_cache_clusters" {
  description = "Nós (primário + réplicas). ≥ 2 liga failover e Multi-AZ."
  type        = number
  default     = 2
}

variable "snapshot_retention_days" {
  description = "Retenção dos snapshots (dias)."
  type        = number
  default     = 7
}
