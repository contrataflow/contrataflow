variable "name" {
  description = "Nome global do bucket."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK do SSE-KMS (alias contrataflow-{env}-storage)."
  type        = string
}

variable "versioning" {
  description = "Versionamento dos objetos."
  type        = bool
  default     = true
}

variable "expiration_days" {
  description = "Expiração dos objetos (ex.: quarentena); null = sem expiração."
  type        = number
  default     = null
}

variable "cors_allowed_origins" {
  description = "Origens do navegador para URLs pré-assinadas (vazio = sem CORS)."
  type        = list(string)
  default     = []
}
