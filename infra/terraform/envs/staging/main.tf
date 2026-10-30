# Raiz de STAGING (architecture.md §11.1): mesma topologia de produção (3 AZs, Multi-AZ), menor em
# tamanho. Dona dos repositórios ECR: as imagens assinadas nascem aqui e são promovidas para
# produção sem rebuild (a conta de produção puxa por política do repositório).
#
# Estado no bucket criado pela raiz de bootstrap: `terraform init -backend-config="bucket=<TF_STATE_BUCKET>"`.
# Identificadores (domínio, issuer…) em terraform.tfvars; valores ligados a contas em
# ci.auto.tfvars.json, gravado pelo pipeline a partir da variável TF_VARS_STAGING.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  backend "s3" {
    key          = "envs/staging/terraform.tfstate"
    region       = "sa-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = "sa-east-1"

  default_tags {
    tags = {
      Project     = "contrataflow"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

module "stack" {
  source = "../../modules/stack"

  environment       = "staging"
  hosted_zone_name  = var.hosted_zone_name
  app_hostname      = var.app_hostname
  email_domain      = var.email_domain
  email_from        = var.email_from
  oidc_issuer_url   = var.oidc_issuer_url
  authentik_api_url = var.authentik_api_url
  otlp_endpoint     = var.otlp_endpoint
  traces_query_url  = var.traces_query_url
  alarm_emails      = var.alarm_emails

  create_ecr           = true
  ecr_pull_account_ids = var.ecr_pull_account_ids

  vpc_cidr_block            = "10.40.0.0/16"
  nat_gateway_per_az        = false
  rds_instance_class        = "db.t4g.medium"
  rds_multi_az              = true
  rds_backup_retention_days = 7
  redis_node_type           = "cache.t4g.small"
  redis_nodes               = 2
  log_retention_days        = 90
  deletion_protection       = false

  services = {
    api    = { cpu = 512, memory = 1024, min = 2, max = 4 }
    web    = { cpu = 512, memory = 1024, min = 2, max = 4 }
    worker = { cpu = 512, memory = 1024, min = 2, max = 4 }
  }
}
