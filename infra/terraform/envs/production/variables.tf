variable "hosted_zone_name" {
  description = "Zona pública do Route 53."
  type        = string
}

variable "app_hostname" {
  description = "Host público do web em produção (PRODUCTION_URL)."
  type        = string
}

variable "email_domain" {
  description = "Domínio de envio de e-mail."
  type        = string
}

variable "email_from" {
  description = "Remetente (EMAIL_FROM)."
  type        = string
}

variable "oidc_issuer_url" {
  description = "Issuer do provider Authentik de produção."
  type        = string
}

variable "authentik_api_url" {
  description = "API de administração do Authentik de produção."
  type        = string
}

variable "otlp_endpoint" {
  description = "Endpoint OTLP do backend de telemetria."
  type        = string
}

variable "traces_query_url" {
  description = "Consulta de traces (TRACES_QUERY_URL)."
  type        = string
}

variable "alarm_emails" {
  description = "E-mails do plantão."
  type        = list(string)
  default     = []
}

variable "ecr_registry" {
  description = "Registry ECR de staging, de onde vêm as imagens promovidas (TF_VARS_PRODUCTION; nunca no código)."
  type        = string
}
