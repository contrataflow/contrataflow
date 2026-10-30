output "vpc_id" {
  description = "Id da VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "Bloco da VPC (origem confiável interna)."
  value       = aws_vpc.this.cidr_block
}

output "s3_prefix_list_id" {
  description = "Prefix list do S3 (gateway endpoint)."
  value       = aws_vpc_endpoint.s3.prefix_list_id
}

output "public_subnet_ids" {
  description = "Sub-redes públicas (ALB)."
  value       = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  description = "Sub-redes privadas de aplicação (ECS)."
  value       = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  description = "Sub-redes privadas de dados (RDS, ElastiCache)."
  value       = aws_subnet.data[*].id
}
