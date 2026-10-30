output "url_secret_arn" {
  description = "Segredo com a URL rediss:// (com AUTH)."
  value       = aws_secretsmanager_secret.url.arn
}

output "replication_group_id" {
  description = "Id do replication group (alarmes)."
  value       = aws_elasticache_replication_group.this.id
}
