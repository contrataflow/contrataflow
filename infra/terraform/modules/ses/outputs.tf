output "identity_arn" {
  description = "Identidade de envio (política do worker)."
  value       = aws_sesv2_email_identity.this.arn
}

output "configuration_set_name" {
  description = "Configuration set do envio."
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "configuration_set_arn" {
  description = "ARN do configuration set (política do worker)."
  value       = aws_sesv2_configuration_set.this.arn
}

output "events_topic_arn" {
  description = "Tópico SNS de bounce e complaint."
  value       = aws_sns_topic.events.arn
}

output "smtp_url_secret_arn" {
  description = "Segredo com a SMTP_URL do worker."
  value       = aws_secretsmanager_secret.smtp_url.arn
}
