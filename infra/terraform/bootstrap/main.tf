# Raiz de BOOTSTRAP — aplicada UMA vez, à mão, por quem administra cada conta AWS (staging e
# produção), antes de qualquer pipeline (roteiro no CONTRIBUTING.md → "Infraestrutura AWS"):
#
#   terraform init && terraform apply -var environment=staging
#
# Cria o que o pipeline precisa para existir: o bucket do estado remoto (com lock nativo do S3 e
# CMK própria), o provedor OIDC do GitHub e três papéis restritos ao repositório:
#   - deploy   (AWS_OIDC_ROLE_ARN): só no ambiente do GitHub — ECR, ECS e PassRole das tasks;
#   - apply    (TF_APPLY_ROLE_ARN): só no ambiente do GitHub — `terraform apply` das raízes envs/*;
#   - plan     (TF_PLAN_ROLE_ARN_<ENV>): leitura para `terraform plan` na main (e nos PRs, só staging).
#
# O estado desta raiz fica local (o bucket ainda não existe quando ela roda); guarde-o no próprio
# bucket depois do apply, como manda o roteiro.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71"
    }
  }
}

provider "aws" {
  region = "sa-east-1"

  default_tags {
    tags = {
      Project     = "contrataflow"
      Environment = var.environment
      ManagedBy   = "terraform-bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  name      = "contrataflow-${var.environment}"
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  oidc_host = "token.actions.githubusercontent.com"
  subject   = "repo:${var.github_repository}"

  plan_subjects = concat(
    ["${local.subject}:ref:refs/heads/main"],
    var.plan_on_pull_request ? ["${local.subject}:pull_request"] : [],
  )
}

# --- Estado remoto --------------------------------------------------------------------------------

resource "aws_kms_key" "state" {
  description             = "${local.name}-tfstate"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "state" {
  name          = "alias/${local.name}-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

module "state_bucket" {
  source = "../modules/s3-bucket"

  name        = "${local.name}-tfstate-${local.account}"
  kms_key_arn = aws_kms_key.state.arn
  versioning  = true
}

# --- OIDC do GitHub -------------------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust_environment" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["${local.subject}:environment:${var.environment}"]
    }
  }
}

data "aws_iam_policy_document" "trust_plan" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = local.plan_subjects
    }
  }
}

# --- Papel de deploy (AWS_OIDC_ROLE_ARN) ----------------------------------------------------------

resource "aws_iam_role" "deploy" {
  name                 = "${local.name}-deploy"
  description          = "Deploy do GitHub Actions (ambiente ${var.environment})"
  assume_role_policy   = data.aws_iam_policy_document.trust_environment.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Push (images.yml) nos repositórios desta conta e leitura de qualquer conta que os compartilhe
  # (produção lê as imagens de staging para verificar a assinatura).
  statement {
    sid = "EcrImagens"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = ["arn:${local.partition}:ecr:${local.region}:*:repository/contrataflow-*"]
  }

  statement {
    sid       = "TaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "Migracao"
    actions   = ["ecs:RunTask"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${local.name}-migrator:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account}:cluster/${local.name}"]
    }
  }

  statement {
    sid     = "Rollout"
    actions = ["ecs:DescribeServices", "ecs:UpdateService", "ecs:DescribeTasks"]
    resources = [
      "arn:${local.partition}:ecs:${local.region}:${local.account}:service/${local.name}/*",
      "arn:${local.partition}:ecs:${local.region}:${local.account}:task/${local.name}/*",
    ]
  }

  statement {
    sid       = "PassRoleDasTasks"
    actions   = ["iam:PassRole"]
    resources = ["arn:${local.partition}:iam::${local.account}:role/contrataflow/ecs/*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# --- Papel do apply (TF_APPLY_ROLE_ARN) -----------------------------------------------------------

# O apply cria VPC, IAM, KMS, RDS… — escopo de administrador nesta conta, que é só do ambiente. O
# limite é quem assume: só jobs no ambiente do GitHub (branch protegida; produção com aprovação).
resource "aws_iam_role" "apply" {
  name                 = "${local.name}-terraform-apply"
  description          = "terraform apply do GitHub Actions (ambiente ${var.environment})"
  assume_role_policy   = data.aws_iam_policy_document.trust_environment.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "apply" {
  role       = aws_iam_role.apply.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AdministratorAccess"
}

# --- Papel do plan (TF_PLAN_ROLE_ARN_<ENV>) -------------------------------------------------------

resource "aws_iam_role" "plan" {
  name                 = "${local.name}-terraform-plan"
  description          = "terraform plan do GitHub Actions (somente leitura)"
  assume_role_policy   = data.aws_iam_policy_document.trust_plan.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "plan" {
  statement {
    sid       = "Estado"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [module.state_bucket.arn, "${module.state_bucket.arn}/*"]
  }

  statement {
    sid       = "EstadoKms"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.state.arn]
  }

  # O refresh lê o valor dos segredos que o próprio Terraform grava (URLs do Redis e do SMTP).
  statement {
    sid     = "SegredosGeridosPeloTerraform"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:${local.partition}:secretsmanager:${local.region}:${local.account}:secret:contrataflow/${var.environment}/redis-*",
      "arn:${local.partition}:secretsmanager:${local.region}:${local.account}:secret:contrataflow/${var.environment}/smtp-url-*",
    ]
  }

  statement {
    sid       = "SegredosKms"
    actions   = ["kms:Decrypt"]
    resources = ["arn:${local.partition}:kms:${local.region}:${local.account}:key/*"]
    condition {
      test     = "ForAnyValue:StringLike"
      variable = "kms:ResourceAliases"
      values   = ["alias/${local.name}-secrets"]
    }
  }

  # ReadOnlyAccess lê objetos de qualquer bucket: o plan não pode ler documentos dos tenants.
  statement {
    sid           = "SemObjetosForaDoEstado"
    effect        = "Deny"
    actions       = ["s3:GetObject", "s3:GetObjectVersion"]
    not_resources = ["${module.state_bucket.arn}/*"]
  }

  # Nem o segredo da aplicação nem a senha mestra do RDS.
  statement {
    sid     = "SemSegredosDaAplicacao"
    effect  = "Deny"
    actions = ["secretsmanager:GetSecretValue"]
    not_resources = [
      "arn:${local.partition}:secretsmanager:${local.region}:${local.account}:secret:contrataflow/${var.environment}/redis-*",
      "arn:${local.partition}:secretsmanager:${local.region}:${local.account}:secret:contrataflow/${var.environment}/smtp-url-*",
    ]
  }
}

resource "aws_iam_role_policy" "plan" {
  name   = "plan"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan.json
}
