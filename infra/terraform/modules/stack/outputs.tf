output "app_url" {
  description = "URL pública do web."
  value       = local.app_url
}

output "app_secret_arn" {
  description = "Segredo JSON `contrataflow/<env>/app` (preencher pelo roteiro)."
  value       = aws_secretsmanager_secret.app.arn
}

output "rds_master_user_secret_arn" {
  description = "Segredo (gerido pelo RDS) do usuário mestre — só para o bootstrap dos papéis cf_*."
  value       = module.rds.master_user_secret_arn
}

output "rds_address" {
  description = "Host do PostgreSQL (para as URLs do segredo da aplicação)."
  value       = module.rds.address
}

output "alarm_topic_arn" {
  description = "Tópico SNS dos alarmes."
  value       = module.observability.alarm_topic_arn
}

# Nomes exatos das variáveis dos ambientes do GitHub (CONTRIBUTING.md → Pipeline de CI), lidas por
# images.yml, deploy-staging.yml e tools/ci/deploy-ecs.ts.
output "deploy_variables" {
  description = "Variáveis comuns dos ambientes staging e production do GitHub."
  value = {
    AWS_OIDC_ROLE_ARN    = data.aws_iam_role.deploy.arn
    AWS_REGION           = local.region
    ECR_REGISTRY         = local.ecr_registry
    ECS_CLUSTER          = aws_ecs_cluster.this.name
    ECS_SERVICE_PREFIX   = local.service_prefix
    ECS_MIGRATOR_FAMILY  = module.migrator.family
    ECS_MIGRATOR_NETWORK = local.migrator_network
  }
}

output "traces_query_url" {
  description = "Consulta de traces do backend (TRACES_QUERY_URL)."
  value       = var.traces_query_url
}
