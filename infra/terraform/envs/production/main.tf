# Raiz de PRODUÇÃO (architecture.md §11.1): conta própria, sa-east-1, Multi-AZ, um NAT por AZ e
# proteção contra exclusão. Não tem ECR: roda as mesmas imagens assinadas de staging, promovidas
# sem rebuild (o registry de staging vem de TF_VARS_PRODUCTION). `apply` só pelo pipeline, depois
# da aprovação do Tech Lead no ambiente `production`.
#
# Estado no bucket criado pela raiz de bootstrap: `terraform init -backend-config="bucket=<TF_STATE_BUCKET>"`.
# Identificadores (domínio, issuer…) em terraform.tfvars; valores ligados a contas em
# ci.auto.tfvars.json, gravado pelo pipeline a partir da variável TF_VARS_PRODUCTION.

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
    key          = "envs/production/terraform.tfstate"
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
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

module "stack" {
  source = "../../modules/stack"

  environment       = "production"
  hosted_zone_name  = var.hosted_zone_name
  app_hostname      = var.app_hostname
  email_domain      = var.email_domain
  email_from        = var.email_from
  oidc_issuer_url   = var.oidc_issuer_url
  authentik_api_url = var.authentik_api_url
  otlp_endpoint     = var.otlp_endpoint
  traces_query_url  = var.traces_query_url
  alarm_emails      = var.alarm_emails

  create_ecr   = false
  ecr_registry = var.ecr_registry

  vpc_cidr_block            = "10.50.0.0/16"
  nat_gateway_per_az        = true
  rds_instance_class        = "db.r7g.large"
  rds_allocated_storage     = 200
  rds_multi_az              = true
  rds_backup_retention_days = 35
  redis_node_type           = "cache.r7g.large"
  redis_nodes               = 2
  log_retention_days        = 365
  deletion_protection       = true

  services = {
    api    = { cpu = 1024, memory = 2048, min = 2, max = 8 }
    web    = { cpu = 1024, memory = 2048, min = 2, max = 8 }
    worker = { cpu = 1024, memory = 2048, min = 2, max = 6 }
  }
}
