# ElastiCache Redis (architecture.md §11.2 · DEC-131): réplica em outra AZ com failover automático,
# TLS em trânsito, cifragem em repouso com CMK e AUTH. O token é gerado aqui e só sai daqui dentro
# do segredo `REDIS_*_URL` (Secrets Manager, CMK `secrets`) que o ECS injeta nas tasks.

locals {
  name = "contrataflow-${var.environment}-${var.purpose}"
}

resource "random_password" "auth" {
  length  = 64
  special = false
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${local.name}-redis"
  description = "Redis somente a partir das tasks da aplicacao"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "redis" {
  for_each = var.allowed_security_group_ids

  security_group_id            = aws_security_group.this.id
  description                  = "Redis a partir de ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = each.value
}

# Sessões e filas não podem ser despejadas: BullMQ exige noeviction e sessão perdida derruba o login.
resource "aws_elasticache_parameter_group" "this" {
  name   = local.name
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.name
  description          = "ContrataFlow ${var.environment} — ${var.purpose}"

  engine               = "redis"
  engine_version       = var.engine_version
  parameter_group_name = aws_elasticache_parameter_group.this.name
  node_type            = var.node_type
  port                 = 6379

  num_cache_clusters         = var.num_cache_clusters
  automatic_failover_enabled = var.num_cache_clusters > 1
  multi_az_enabled           = var.num_cache_clusters > 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = random_password.auth.result

  snapshot_retention_limit   = var.snapshot_retention_days
  snapshot_window            = "04:00-05:00"
  maintenance_window         = "sun:07:30-sun:08:30"
  auto_minor_version_upgrade = true
  apply_immediately          = false
}

resource "aws_secretsmanager_secret" "url" {
  name        = "contrataflow/${var.environment}/redis-${var.purpose}"
  description = "URL rediss:// com AUTH do Redis ${var.purpose}"
  kms_key_id  = var.secrets_kms_key_arn
}

resource "aws_secretsmanager_secret_version" "url" {
  secret_id     = aws_secretsmanager_secret.url.id
  secret_string = "rediss://:${random_password.auth.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
}
