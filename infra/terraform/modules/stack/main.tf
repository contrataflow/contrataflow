# Composição de um ambiente AWS do ContrataFlow (architecture.md §11.2–§11.4), usada pelas raízes
# envs/staging e envs/production — que só mudam tamanho, redundância e identificadores. Nada de
# segredo nem de id de conta aqui: os valores secretos ficam no Secrets Manager (preenchidos pelo
# roteiro do CONTRIBUTING.md ou gerados por recurso) e a conta vem das credenciais do pipeline.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

data "aws_route53_zone" "this" {
  name         = var.hosted_zone_name
  private_zone = false
}

locals {
  name    = "contrataflow-${var.environment}"
  region  = data.aws_region.current.region
  account = data.aws_caller_identity.current.account_id
  app_url = "https://${var.app_hostname}"

  ecr_registry   = var.create_ecr ? module.ecr[0].registry : var.ecr_registry
  ecr_repo_arns  = ["arn:aws:ecr:${local.region}:${split(".", local.ecr_registry)[0]}:repository/contrataflow-*"]
  image          = { for app in ["api", "web", "worker", "gotenberg", "clamav"] : app => "${local.ecr_registry}/contrataflow-${app}" }
  app_secret_arn = aws_secretsmanager_secret.app.arn

  # Chave do segredo JSON `contrataflow/<env>/app` → variável da task.
  app_secret = { for key in var.app_secret_keys : key => "${local.app_secret_arn}:${key}::" }

  # Saúde por HTTP sem curl na imagem (runtime -slim): o próprio Node consulta o /health/ready.
  node_health = "node -e \"fetch('http://127.0.0.1:%d/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\""

  common_environment = {
    APP_ENV                     = var.environment
    APP_BASE_URL                = local.app_url
    LOG_LEVEL                   = "info"
    OTEL_EXPORTER_OTLP_ENDPOINT = var.otlp_endpoint
  }

  storage_environment = {
    S3_REGION            = local.region
    S3_BUCKET_QUARANTINE = module.bucket["quarantine"].id
    S3_BUCKET_DOCUMENTS  = module.bucket["documents"].id
    S3_BUCKET_RENDITIONS = module.bucket["renditions"].id
    # Path-style no endpoint regional: a CSP do web libera exatamente essa origem (connect-src).
    S3_PUBLIC_ENDPOINT  = "https://s3.${data.aws_region.current.region}.amazonaws.com"
    S3_FORCE_PATH_STYLE = "true"
  }

  # Contrato com tools/ci/deploy-ecs.ts e com as variáveis dos ambientes do GitHub.
  service_prefix   = local.name
  migrator_family  = "${local.name}-migrator"
  migrator_network = jsonencode({ awsvpcConfiguration = { subnets = module.network.app_subnet_ids, securityGroups = [module.migrator.security_group_id], assignPublicIp = "DISABLED" } })
}

# --- Chaves, rede e armazenamento -----------------------------------------------------------------

module "kms" {
  source      = "../kms"
  environment = var.environment
}

module "network" {
  source             = "../network"
  environment        = var.environment
  cidr_block         = var.vpc_cidr_block
  availability_zones = var.availability_zones
  nat_gateway_per_az = var.nat_gateway_per_az
  logs_kms_key_arn   = module.kms.key_arns["logs"]
  log_retention_days = var.log_retention_days
}

module "bucket" {
  source   = "../s3-bucket"
  for_each = { quarantine = 1, documents = null, renditions = null }

  name                 = "${local.name}-${each.key}-${local.account}"
  kms_key_arn          = module.kms.key_arns["storage"]
  expiration_days      = each.value
  cors_allowed_origins = each.key == "renditions" ? [] : [local.app_url]
}

module "ecr" {
  source = "../ecr"
  count  = var.create_ecr ? 1 : 0

  apps             = ["api", "web", "worker", "gotenberg", "clamav"]
  pull_account_ids = var.ecr_pull_account_ids
}

# --- Segredos -------------------------------------------------------------------------------------

# JSON com as chaves de `app_secret_keys`, preenchido fora do Terraform (roteiro no CONTRIBUTING.md).
# Cada contêiner recebe só as chaves que usa (`valueFrom` com a chave).
resource "aws_secretsmanager_secret" "app" {
  name        = "contrataflow/${var.environment}/app"
  description = "Segredos da aplicacao (JSON); valores definidos pelo roteiro de bootstrap"
  kms_key_id  = module.kms.key_arns["secrets"]
}

module "redis" {
  source   = "../elasticache"
  for_each = toset(["sessions", "main"])

  environment         = var.environment
  purpose             = each.key
  vpc_id              = module.network.vpc_id
  subnet_ids          = module.network.data_subnet_ids
  kms_key_arn         = module.kms.key_arns["storage"]
  secrets_kms_key_arn = module.kms.key_arns["secrets"]
  node_type           = var.redis_node_type
  num_cache_clusters  = var.redis_nodes
  allowed_security_group_ids = {
    api    = module.api.security_group_id
    web    = module.web.security_group_id
    worker = module.worker.security_group_id
  }
}

# --- Dados ----------------------------------------------------------------------------------------

module "rds" {
  source = "../rds-postgres"

  environment           = var.environment
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.data_subnet_ids
  kms_key_arn           = module.kms.key_arns["rds"]
  secrets_kms_key_arn   = module.kms.key_arns["secrets"]
  instance_class        = var.rds_instance_class
  allocated_storage     = var.rds_allocated_storage
  multi_az              = var.rds_multi_az
  backup_retention_days = var.rds_backup_retention_days
  deletion_protection   = var.deletion_protection
  allowed_security_group_ids = {
    api      = module.api.security_group_id
    worker   = module.worker.security_group_id
    migrator = module.migrator.security_group_id
  }
}

# --- E-mail ---------------------------------------------------------------------------------------

module "ses" {
  source = "../ses"

  environment     = var.environment
  domain          = var.email_domain
  zone_id         = data.aws_route53_zone.this.zone_id
  sns_kms_key_arn = module.kms.key_arns["logs"]

  secrets_kms_key_arn = module.kms.key_arns["secrets"]
}

# --- Borda: certificado, ALB e WAF ----------------------------------------------------------------

resource "aws_acm_certificate" "app" {
  domain_name       = var.app_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate" {
  for_each = {
    for option in aws_acm_certificate.app.domain_validation_options : option.domain_name => option
  }

  zone_id = data.aws_route53_zone.this.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  ttl     = 300
  records = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate : record.fqdn]
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB publico: HTTPS da internet, saida so para o web"
  vpc_id      = module.network.vpc_id
}

# trivy:ignore:AVD-AWS-0107 Borda pública da aplicação (443/80 → redireciona), atrás do WAF.
resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each = toset(["80", "443"])

  security_group_id = aws_security_group.alb.id
  description       = "Porta ${each.key} da internet"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Para as tasks do web"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = module.web.security_group_id
}

# trivy:ignore:AVD-AWS-0053 O ALB do web é a borda pública por desenho (WAF associado).
resource "aws_lb" "this" {
  name                       = local.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = module.network.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.name}-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.network.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = aws_acm_certificate_validation.app.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = [var.app_hostname]
    }
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.app_hostname
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

module "waf" {
  source = "../waf"

  environment        = var.environment
  alb_arn            = aws_lb.this.arn
  logs_kms_key_arn   = module.kms.key_arns["logs"]
  log_retention_days = var.log_retention_days
}

# --- ECS: cluster, descoberta interna e serviços --------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_service_discovery_http_namespace" "this" {
  name        = "${local.name}.internal"
  description = "Service Connect do ContrataFlow ${var.environment}"
}

data "aws_iam_policy_document" "storage" {
  statement {
    sid       = "Objetos"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectTagging", "s3:PutObjectTagging"]
    resources = [for bucket in module.bucket : "${bucket.arn}/*"]
  }

  statement {
    sid       = "Buckets"
    actions   = ["s3:ListBucket"]
    resources = [for bucket in module.bucket : bucket.arn]
  }

  statement {
    sid       = "Cmk"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [module.kms.key_arns["storage"]]
  }
}

locals {
  service_common = {
    environment         = var.environment
    cluster_arn         = aws_ecs_cluster.this.arn
    cluster_name        = aws_ecs_cluster.this.name
    vpc_id              = module.network.vpc_id
    vpc_cidr_block      = module.network.vpc_cidr_block
    subnet_ids          = module.network.app_subnet_ids
    logs_kms_key_arn    = module.kms.key_arns["logs"]
    secrets_kms_key_arn = module.kms.key_arns["secrets"]
    ecr_repository_arns = local.ecr_repo_arns
    namespace_arn       = aws_service_discovery_http_namespace.this.arn
    log_retention_days  = var.log_retention_days
  }
}

module "api" {
  source = "../ecs-service"

  environment                   = local.service_common.environment
  name                          = "${local.service_prefix}-api"
  container_name                = "api"
  image                         = "${local.image.api}:bootstrap"
  cpu                           = var.services.api.cpu
  memory                        = var.services.api.memory
  desired_count                 = var.services.api.min
  max_count                     = var.services.api.max
  port                          = 4000
  health_check_command          = format(local.node_health, 4000)
  cluster_arn                   = local.service_common.cluster_arn
  cluster_name                  = local.service_common.cluster_name
  vpc_id                        = local.service_common.vpc_id
  vpc_cidr_block                = local.service_common.vpc_cidr_block
  subnet_ids                    = local.service_common.subnet_ids
  logs_kms_key_arn              = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn           = local.service_common.secrets_kms_key_arn
  ecr_repository_arns           = local.service_common.ecr_repository_arns
  service_connect_namespace_arn = local.service_common.namespace_arn
  log_retention_days            = local.service_common.log_retention_days
  ingress_security_group_ids    = { web = module.web.security_group_id }
  egress_vpc_ports              = [5432, 6379, 3000, 3310]
  task_policy_json              = data.aws_iam_policy_document.storage.json
  secret_arns                   = [local.app_secret_arn, module.redis["sessions"].url_secret_arn, module.redis["main"].url_secret_arn]

  environment_variables = merge(local.common_environment, local.storage_environment, {
    PORT                = "4000"
    OIDC_ISSUER_URL     = var.oidc_issuer_url
    OIDC_AUDIENCE       = var.oidc_audience
    AUTHENTIK_API_URL   = var.authentik_api_url
    TRUSTED_PROXY_CIDRS = module.network.vpc_cidr_block
    CLAMAV_HOST         = "clamav"
    CLAMAV_PORT         = "3310"
    GOTENBERG_URL       = "http://gotenberg:3000"
    OTEL_SERVICE_NAME   = "contrataflow-api"
  })
  secrets = merge(
    { for key in ["DATABASE_URL", "DATABASE_URL_PLATFORM", "INTERNAL_SERVICE_TOKEN", "AUTHENTIK_API_TOKEN", "FIELD_ENCRYPTION_KEY", "BLIND_INDEX_KEY"] : key => local.app_secret[key == "DATABASE_URL" ? "DATABASE_URL_APP" : key] },
    {
      REDIS_SESSION_URL = module.redis["sessions"].url_secret_arn
      REDIS_URL         = module.redis["main"].url_secret_arn
      REDIS_CACHE_URL   = module.redis["main"].url_secret_arn
    },
  )
}

module "web" {
  source = "../ecs-service"

  environment                   = local.service_common.environment
  name                          = "${local.service_prefix}-web"
  container_name                = "web"
  image                         = "${local.image.web}:bootstrap"
  cpu                           = var.services.web.cpu
  memory                        = var.services.web.memory
  desired_count                 = var.services.web.min
  max_count                     = var.services.web.max
  port                          = 3000
  health_check_command          = format(local.node_health, 3000)
  writable_paths                = ["/tmp", "/app/apps/web/.next/cache"]
  cluster_arn                   = local.service_common.cluster_arn
  cluster_name                  = local.service_common.cluster_name
  vpc_id                        = local.service_common.vpc_id
  vpc_cidr_block                = local.service_common.vpc_cidr_block
  subnet_ids                    = local.service_common.subnet_ids
  logs_kms_key_arn              = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn           = local.service_common.secrets_kms_key_arn
  ecr_repository_arns           = local.service_common.ecr_repository_arns
  service_connect_namespace_arn = local.service_common.namespace_arn
  log_retention_days            = local.service_common.log_retention_days
  target_group_arn              = aws_lb_target_group.web.arn
  ingress_security_group_ids    = { alb = aws_security_group.alb.id }
  egress_vpc_ports              = [4000, 6379]
  secret_arns                   = [local.app_secret_arn, module.redis["sessions"].url_secret_arn, module.redis["main"].url_secret_arn]

  environment_variables = merge(local.common_environment, {
    API_INTERNAL_URL     = "http://api:4000"
    S3_PUBLIC_ENDPOINT   = local.storage_environment.S3_PUBLIC_ENDPOINT
    S3_BUCKET_QUARANTINE = local.storage_environment.S3_BUCKET_QUARANTINE
    S3_BUCKET_RENDITIONS = local.storage_environment.S3_BUCKET_RENDITIONS
    OIDC_ISSUER_URL      = var.oidc_issuer_url
    OIDC_CLIENT_ID       = var.oidc_client_id
    OIDC_REDIRECT_URI    = "${local.app_url}/api/auth/callback"
    TRUSTED_PROXY_CIDRS  = module.network.vpc_cidr_block
    OTEL_SERVICE_NAME    = "contrataflow-web"
  })
  secrets = merge(
    { for key in ["OIDC_CLIENT_SECRET", "SESSION_ENCRYPTION_KEY", "INTERNAL_SERVICE_TOKEN"] : key => local.app_secret[key] },
    {
      REDIS_SESSION_URL = module.redis["sessions"].url_secret_arn
      REDIS_URL         = module.redis["main"].url_secret_arn
    },
  )
}

module "worker" {
  source = "../ecs-service"

  environment                   = local.service_common.environment
  name                          = "${local.service_prefix}-worker"
  container_name                = "worker"
  image                         = "${local.image.worker}:bootstrap"
  cpu                           = var.services.worker.cpu
  memory                        = var.services.worker.memory
  desired_count                 = var.services.worker.min
  max_count                     = var.services.worker.max
  cluster_arn                   = local.service_common.cluster_arn
  cluster_name                  = local.service_common.cluster_name
  vpc_id                        = local.service_common.vpc_id
  vpc_cidr_block                = local.service_common.vpc_cidr_block
  subnet_ids                    = local.service_common.subnet_ids
  logs_kms_key_arn              = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn           = local.service_common.secrets_kms_key_arn
  ecr_repository_arns           = local.service_common.ecr_repository_arns
  service_connect_namespace_arn = local.service_common.namespace_arn
  log_retention_days            = local.service_common.log_retention_days
  egress_vpc_ports              = [5432, 6379, 3000, 3310, 465]
  task_policy_json              = data.aws_iam_policy_document.storage.json
  secret_arns                   = [local.app_secret_arn, module.ses.smtp_url_secret_arn, module.redis["sessions"].url_secret_arn, module.redis["main"].url_secret_arn]

  environment_variables = merge(local.common_environment, local.storage_environment, {
    AUTHENTIK_API_URL = var.authentik_api_url
    GOTENBERG_URL     = "http://gotenberg:3000"
    CLAMAV_HOST       = "clamav"
    CLAMAV_PORT       = "3310"
    EMAIL_TRANSPORT   = "smtp"
    EMAIL_FROM        = var.email_from
    OTEL_SERVICE_NAME = "contrataflow-worker"
  })
  secrets = merge(
    {
      DATABASE_URL             = local.app_secret["DATABASE_URL_APP"]
      DATABASE_URL_WORKER      = local.app_secret["DATABASE_URL_WORKER"]
      DATABASE_URL_PLATFORM    = local.app_secret["DATABASE_URL_PLATFORM"]
      DATABASE_URL_RELAY       = local.app_secret["DATABASE_URL_RELAY"]
      DATABASE_URL_MAINTENANCE = local.app_secret["DATABASE_URL_MAINTENANCE"]
      AUTHENTIK_API_TOKEN      = local.app_secret["AUTHENTIK_API_TOKEN"]
      FIELD_ENCRYPTION_KEY     = local.app_secret["FIELD_ENCRYPTION_KEY"]
      BLIND_INDEX_KEY          = local.app_secret["BLIND_INDEX_KEY"]
      SMTP_URL                 = module.ses.smtp_url_secret_arn
      REDIS_SESSION_URL        = module.redis["sessions"].url_secret_arn
      REDIS_URL                = module.redis["main"].url_secret_arn
      REDIS_CACHE_URL          = module.redis["main"].url_secret_arn
    },
  )
}

# Migração one-off (architecture.md §11.4): a imagem é a da api (deploy-ecs.ts troca pelo digest)
# e roda com o papel `cf_migrator` (DATABASE_MIGRATION_URL) antes do rollout.
module "migrator" {
  source = "../ecs-service"

  environment         = local.service_common.environment
  name                = local.migrator_family
  container_name      = "migrator"
  image               = "${local.image.api}:bootstrap"
  command             = var.migrator_command
  cpu                 = 512
  memory              = 1024
  create_service      = false
  vpc_id              = local.service_common.vpc_id
  vpc_cidr_block      = local.service_common.vpc_cidr_block
  subnet_ids          = local.service_common.subnet_ids
  logs_kms_key_arn    = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn = local.service_common.secrets_kms_key_arn
  ecr_repository_arns = local.service_common.ecr_repository_arns
  log_retention_days  = local.service_common.log_retention_days
  egress_vpc_ports    = [5432]
  secret_arns         = [local.app_secret_arn]
  secrets             = { DATABASE_MIGRATION_URL = local.app_secret["DATABASE_MIGRATION_URL"] }
  environment_variables = {
    APP_ENV = var.environment
  }
}

# Serviços internos de terceiros, espelhados no ECR (sem pull do Docker Hub em produção). Gotenberg
# sem saída para a internet; ClamAV só com HTTPS (espelho de assinaturas do freshclam). As imagens
# oficiais gravam fora de /tmp, então a raiz fica gravável — sem privilégio e sem porta pública.
module "gotenberg" {
  source = "../ecs-service"

  environment                   = local.service_common.environment
  name                          = "${local.service_prefix}-gotenberg"
  container_name                = "gotenberg"
  image                         = "${local.image.gotenberg}:${var.gotenberg_version}"
  user                          = null
  readonly_root_filesystem      = false
  writable_paths                = []
  cpu                           = 1024
  memory                        = 2048
  desired_count                 = var.services.worker.min
  max_count                     = var.services.worker.max
  port                          = 3000
  cluster_arn                   = local.service_common.cluster_arn
  cluster_name                  = local.service_common.cluster_name
  vpc_id                        = local.service_common.vpc_id
  vpc_cidr_block                = local.service_common.vpc_cidr_block
  subnet_ids                    = local.service_common.subnet_ids
  logs_kms_key_arn              = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn           = local.service_common.secrets_kms_key_arn
  ecr_repository_arns           = local.service_common.ecr_repository_arns
  service_connect_namespace_arn = local.service_common.namespace_arn
  log_retention_days            = local.service_common.log_retention_days
  ingress_security_group_ids    = { worker = module.worker.security_group_id }
  allow_https_egress            = false
  egress_vpc_ports              = [443]
  egress_prefix_list_ids        = [module.network.s3_prefix_list_id]
}

module "clamav" {
  source = "../ecs-service"

  environment                   = local.service_common.environment
  name                          = "${local.service_prefix}-clamav"
  container_name                = "clamav"
  image                         = "${local.image.clamav}:${var.clamav_version}"
  user                          = null
  readonly_root_filesystem      = false
  writable_paths                = []
  cpu                           = 1024
  memory                        = 4096
  desired_count                 = var.services.worker.min
  max_count                     = var.services.worker.min
  port                          = 3310
  cluster_arn                   = local.service_common.cluster_arn
  cluster_name                  = local.service_common.cluster_name
  vpc_id                        = local.service_common.vpc_id
  vpc_cidr_block                = local.service_common.vpc_cidr_block
  subnet_ids                    = local.service_common.subnet_ids
  logs_kms_key_arn              = local.service_common.logs_kms_key_arn
  secrets_kms_key_arn           = local.service_common.secrets_kms_key_arn
  ecr_repository_arns           = local.service_common.ecr_repository_arns
  service_connect_namespace_arn = local.service_common.namespace_arn
  log_retention_days            = local.service_common.log_retention_days
  ingress_security_group_ids    = { api = module.api.security_group_id, worker = module.worker.security_group_id }
}

# --- Observabilidade ------------------------------------------------------------------------------

module "observability" {
  source = "../observability"

  environment             = var.environment
  sns_kms_key_arn         = module.kms.key_arns["logs"]
  alarm_emails            = var.alarm_emails
  alb_arn_suffix          = aws_lb.this.arn_suffix
  target_group_arn_suffix = aws_lb_target_group.web.arn_suffix
  ecs_cluster_name        = aws_ecs_cluster.this.name
  ecs_service_names = [
    for service in [module.api, module.web, module.worker, module.gotenberg, module.clamav] : service.service_name
  ]
  rds_identifier              = module.rds.identifier
  redis_replication_group_ids = [for redis in module.redis : redis.replication_group_id]
}

# Papel de deploy criado pela raiz de bootstrap (AWS_OIDC_ROLE_ARN do ambiente do GitHub).
data "aws_iam_role" "deploy" {
  name = "${local.name}-deploy"
}
