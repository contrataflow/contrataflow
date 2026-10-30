variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "sns_kms_key_arn" {
  description = "CMK do tópico de alarmes (a de logs aceita o CloudWatch)."
  type        = string
}

variable "alarm_emails" {
  description = "E-mails do plantão inscritos no tópico de alarmes (confirmação por e-mail)."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  description = "Sufixo do ARN do ALB (dimensão das métricas)."
  type        = string
}

variable "target_group_arn_suffix" {
  description = "Sufixo do ARN do target group do web."
  type        = string
}

variable "ecs_cluster_name" {
  description = "Cluster ECS."
  type        = string
}

variable "ecs_service_names" {
  description = "Serviços ECS monitorados."
  type        = list(string)
}

variable "rds_identifier" {
  description = "Instância RDS."
  type        = string
}

variable "redis_replication_group_ids" {
  description = "Replication groups do ElastiCache."
  type        = list(string)
}
