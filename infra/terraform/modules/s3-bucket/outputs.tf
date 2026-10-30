output "id" {
  description = "Nome do bucket."
  value       = aws_s3_bucket.this.id
}

output "arn" {
  description = "ARN do bucket."
  value       = aws_s3_bucket.this.arn
}
