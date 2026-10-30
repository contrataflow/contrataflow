# CMKs por finalidade (architecture.md §11.2): alias/contrataflow-{env}-{finalidade}. Rotação anual
# automática e janela de exclusão máxima. A chave `logs` também aceita o CloudWatch Logs (log groups,
# flow logs da VPC e logs do WAF) e o SNS dos alarmes; as demais ficam só com a conta (IAM decide).

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_root = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
  region       = data.aws_region.current.region
}

data "aws_iam_policy_document" "key" {
  for_each = toset(var.purposes)

  statement {
    sid       = "Conta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid = "CloudWatchLogs"
      actions = [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*",
      ]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["logs.${local.region}.amazonaws.com"]
      }
      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:${data.aws_partition.current.partition}:logs:${local.region}:${data.aws_caller_identity.current.account_id}:*"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid       = "AlarmesNoSns"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["cloudwatch.amazonaws.com", "ses.amazonaws.com"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  for_each = toset(var.purposes)

  description             = "contrataflow-${var.environment}-${each.key}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key[each.key].json
}

resource "aws_kms_alias" "this" {
  for_each = toset(var.purposes)

  name          = "alias/contrataflow-${var.environment}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
