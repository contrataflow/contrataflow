# `terraform output -json github_environment_variables` → variáveis do ambiente `production` do
# GitHub (roteiro no CONTRIBUTING.md → "Infraestrutura AWS (Terraform)").
output "github_environment_variables" {
  description = "Variáveis do ambiente production do GitHub, com os nomes exatos."
  value = merge(module.stack.deploy_variables, {
    PRODUCTION_URL = module.stack.app_url
  })
}

output "app_secret_arn" {
  description = "Segredo JSON da aplicação (preencher pelo roteiro)."
  value       = module.stack.app_secret_arn
}

output "rds_master_user_secret_arn" {
  description = "Segredo do usuário mestre do RDS (bootstrap dos papéis cf_*)."
  value       = module.stack.rds_master_user_secret_arn
}

output "rds_address" {
  description = "Host do PostgreSQL."
  value       = module.stack.rds_address
}
