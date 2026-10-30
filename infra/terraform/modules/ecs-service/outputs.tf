output "family" {
  description = "Família da task definition."
  value       = aws_ecs_task_definition.this.family
}

output "security_group_id" {
  description = "SG das tasks."
  value       = aws_security_group.this.id
}

output "task_role_arn" {
  description = "Papel da task."
  value       = aws_iam_role.task.arn
}

output "execution_role_arn" {
  description = "Papel de execução."
  value       = aws_iam_role.execution.arn
}

output "service_name" {
  description = "Nome do serviço (null quando só há task definition)."
  value       = var.create_service ? aws_ecs_service.this[0].name : null
}
