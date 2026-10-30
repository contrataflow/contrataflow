# SES em sa-east-1 (architecture.md §11.2): identidade do domínio de envio com DKIM (Easy DKIM),
# MAIL FROM próprio (SPF alinhado), DMARC e configuration set que publica bounce e complaint num
# tópico SNS cifrado. Os registros DNS vão para a zona do Route 53 do ambiente.
#
# O worker envia pela interface SMTP do SES (EMAIL_TRANSPORT=smtp, US-112), que só aceita
# credencial de usuário IAM: um usuário sem console, restrito a SendRawEmail nesta identidade e
# neste configuration set. A URL smtps:// vai para o Secrets Manager; rotação = `terraform apply
# -replace` da chave de acesso seguido de novo deploy.

locals {
  name           = "contrataflow-${var.environment}"
  mail_from_host = "bounce.${var.domain}"
}

data "aws_region" "current" {}

resource "aws_sesv2_email_identity" "this" {
  email_identity         = var.domain
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
}

resource "aws_route53_record" "dkim" {
  count = 3

  zone_id = var.zone_id
  name    = "${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "this" {
  email_identity         = aws_sesv2_email_identity.this.email_identity
  mail_from_domain       = local.mail_from_host
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = var.zone_id
  name    = local.mail_from_host
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${data.aws_region.current.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = var.zone_id
  name    = local.mail_from_host
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 1800
  records = [var.dmarc_policy]
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = local.name

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sns_topic" "events" {
  name              = "${local.name}-ses-events"
  kms_master_key_id = var.sns_kms_key_arn
}

resource "aws_sesv2_configuration_set_event_destination" "this" {
  configuration_set_name = aws_sesv2_configuration_set.this.configuration_set_name
  event_destination_name = "bounce-complaint"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT"]

    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }
}

# --- Credencial SMTP do worker --------------------------------------------------------------------

resource "aws_iam_user" "smtp" {
  name = "${local.name}-ses-smtp"
  path = "/contrataflow/"
}

data "aws_iam_policy_document" "smtp" {
  statement {
    actions   = ["ses:SendRawEmail"]
    resources = [aws_sesv2_email_identity.this.arn, aws_sesv2_configuration_set.this.arn]
  }
}

resource "aws_iam_user_policy" "smtp" {
  name   = "ses-smtp"
  user   = aws_iam_user.smtp.name
  policy = data.aws_iam_policy_document.smtp.json
}

resource "aws_iam_access_key" "smtp" {
  user = aws_iam_user.smtp.name
}

resource "aws_secretsmanager_secret" "smtp_url" {
  name        = "contrataflow/${var.environment}/smtp-url"
  description = "SMTP_URL do worker (interface SMTP do SES)"
  kms_key_id  = var.secrets_kms_key_arn
}

resource "aws_secretsmanager_secret_version" "smtp_url" {
  secret_id     = aws_secretsmanager_secret.smtp_url.id
  secret_string = "smtps://${aws_iam_access_key.smtp.id}:${urlencode(aws_iam_access_key.smtp.ses_smtp_password_v4)}@email-smtp.${data.aws_region.current.region}.amazonaws.com:465"
}
