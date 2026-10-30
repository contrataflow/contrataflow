# Repositórios ECR das imagens de infra/docker/prod.Dockerfile (`contrataflow-<app>`, como em
# .github/workflows/images.yml). Tag do commit imutável — a imagem é promovida sem rebuild —, com
# exceção só para as tags `sha256-*` que o cosign grava (assinatura e atestado do SBOM). Varredura
# no push e retenção limitada. Outras contas (produção) podem puxar por política do repositório.

data "aws_partition" "current" {}

locals {
  pull_principals = [
    for account in var.pull_account_ids : "arn:${data.aws_partition.current.partition}:iam::${account}:root"
  ]
}

# A tag do commit é imutável; só as tags `sha256-*` do cosign aceitam regravação (reexecução da
# assinatura/atestado do mesmo digest). O Trivy só reconhece IMMUTABLE puro.
# trivy:ignore:AVD-AWS-0031
resource "aws_ecr_repository" "this" {
  for_each = toset(var.apps)

  name                 = "contrataflow-${each.key}"
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"

  image_tag_mutability_exclusion_filter {
    filter      = "sha256-*"
    filter_type = "WILDCARD"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  # AES256 gerenciada pela AWS: a conta de produção puxa sem precisar de concessão na CMK desta.
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove imagens sem tag depois de 14 dias"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Mantém as últimas imagens com tag"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.max_images }
        action       = { type = "expire" }
      },
    ]
  })
}

data "aws_iam_policy_document" "pull" {
  count = length(local.pull_principals) == 0 ? 0 : 1

  statement {
    sid = "PullOutrasContas"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    principals {
      type        = "AWS"
      identifiers = local.pull_principals
    }
  }
}

resource "aws_ecr_repository_policy" "pull" {
  for_each = length(local.pull_principals) == 0 ? {} : aws_ecr_repository.this

  repository = each.value.name
  policy     = data.aws_iam_policy_document.pull[0].json
}
