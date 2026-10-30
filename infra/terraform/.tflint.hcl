# TFLint (spec-469): regras recomendadas da linguagem + ruleset da AWS (tipos de instância, classes
# de RDS/ElastiCache e afins inválidos). Rodado por `pnpm ci:terraform` (tools/ci/terraform.ts).
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.49.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}
