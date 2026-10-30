output "registry" {
  description = "Registry (`<conta>.dkr.ecr.<região>.amazonaws.com`) — variável ECR_REGISTRY."
  value       = split("/", values(aws_ecr_repository.this)[0].repository_url)[0]
}

output "repository_arns" {
  description = "ARN por app."
  value       = { for app, repository in aws_ecr_repository.this : app => repository.arn }
}

output "repository_urls" {
  description = "URL por app."
  value       = { for app, repository in aws_ecr_repository.this : app => repository.repository_url }
}
