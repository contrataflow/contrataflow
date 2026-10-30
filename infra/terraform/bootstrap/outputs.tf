# Variáveis do GitHub (CONTRIBUTING.md → "Infraestrutura AWS (Terraform)"). As do repositório levam
# o sufixo do ambiente; as do ambiente do GitHub, não.
output "repository_variables" {
  description = "Variáveis do REPOSITÓRIO (sufixo _STAGING ou _PRODUCTION)."
  value = {
    "TF_STATE_BUCKET_${upper(var.environment)}"  = module.state_bucket.id
    "TF_PLAN_ROLE_ARN_${upper(var.environment)}" = aws_iam_role.plan.arn
  }
}

output "environment_variables" {
  description = "Variáveis do AMBIENTE do GitHub com o mesmo nome desta conta."
  value = {
    AWS_OIDC_ROLE_ARN = aws_iam_role.deploy.arn
    AWS_REGION        = local.region
    TF_APPLY_ROLE_ARN = aws_iam_role.apply.arn
  }
}
