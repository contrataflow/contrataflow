output "address" {
  description = "Host do PostgreSQL."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Porta do PostgreSQL."
  value       = aws_db_instance.this.port
}

output "master_user_secret_arn" {
  description = "Segredo (gerido pelo RDS) com a senha do usuário mestre."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "identifier" {
  description = "Identificador da instância (alarmes)."
  value       = aws_db_instance.this.identifier
}
