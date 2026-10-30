variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "domain" {
  description = "Domínio de envio (o do EMAIL_FROM)."
  type        = string
}

variable "zone_id" {
  description = "Zona do Route 53 que hospeda o domínio de envio."
  type        = string
}

variable "dmarc_policy" {
  description = "Registro DMARC."
  type        = string
  default     = "v=DMARC1; p=quarantine; adkim=s; aspf=s"
}

variable "secrets_kms_key_arn" {
  description = "CMK `secrets` (segredo SMTP_URL)."
  type        = string
}

variable "sns_kms_key_arn" {
  description = "CMK do tópico de eventos (a de logs aceita o SES)."
  type        = string
}
