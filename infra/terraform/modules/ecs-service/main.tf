# Um serviço ECS Fargate por contêiner (architecture.md §11.2/§11.4): task definition com a família
# igual ao nome do serviço e o contêiner com o nome do app — o contrato de tools/ci/deploy-ecs.ts
# (`<ECS_SERVICE_PREFIX>-<app>`, contêiner `<app>`; migração: família ECS_MIGRATOR_FAMILY, contêiner
# `migrator`). Raiz somente leitura, sem privilégios, usuário da imagem (não-root); escrita só nos
# volumes efêmeros declarados. Rolling update 100/200 com circuit breaker e rollback automático.
#
# O pipeline registra as revisões novas com a imagem por digest; o Terraform não volta o serviço
# para a revisão dele (`ignore_changes`). Mudança de ambiente/segredo feita aqui entra no deploy
# seguinte, que parte da última revisão da família.

data "aws_region" "current" {}

locals {
  region     = data.aws_region.current.region
  log_group  = "/contrataflow/${var.environment}/${var.name}"
  readonly   = var.readonly_root_filesystem
  port_names = var.port == null ? [] : [var.container_name]
  volumes    = { for index, path in var.writable_paths : "tmp-${index}" => path }

  container = merge(
    {
      name                   = var.container_name
      image                  = var.image
      essential              = true
      readonlyRootFilesystem = local.readonly
      privileged             = false
      linuxParameters        = { initProcessEnabled = true }
      environment = [
        for key in sort(keys(var.environment_variables)) : { name = key, value = var.environment_variables[key] }
      ]
      secrets = [
        for key in sort(keys(var.secrets)) : { name = key, valueFrom = var.secrets[key] }
      ]
      mountPoints = [
        for volume, path in local.volumes : { sourceVolume = volume, containerPath = path, readOnly = false }
      ]
      portMappings = var.port == null ? [] : [
        { name = var.container_name, containerPort = var.port, protocol = "tcp", appProtocol = "http" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = local.region
          awslogs-stream-prefix = var.container_name
        }
      }
    },
    var.user == null ? {} : { user = var.user },
    var.command == null ? {} : { command = var.command },
    var.health_check_command == null ? {} : {
      healthCheck = {
        command     = ["CMD-SHELL", var.health_check_command]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    },
  )
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

# --- Papéis: execução (puxar imagem, logs, injetar segredos) e da task (o que o app chama) ------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  path               = "/contrataflow/ecs/"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = var.ecr_repository_arns
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = length(var.secret_arns) == 0 ? [] : [1]
    content {
      sid       = "Segredos"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = var.secret_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.secret_arns) == 0 ? [] : [1]
    content {
      sid       = "SegredosKms"
      actions   = ["kms:Decrypt"]
      resources = [var.secrets_kms_key_arn]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  path               = "/contrataflow/ecs/"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "task" {
  count = var.task_policy_json == null ? 0 : 1

  name   = "app"
  role   = aws_iam_role.task.id
  policy = var.task_policy_json
}

# --- Task definition ------------------------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  dynamic "volume" {
    for_each = local.volumes
    content {
      name = volume.key
    }
  }
}

# --- Rede e serviço -------------------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = var.name
  description = "Tasks de ${var.name}"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "this" {
  for_each = var.port == null ? {} : var.ingress_security_group_ids

  security_group_id            = aws_security_group.this.id
  description                  = "Porta do app a partir de ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = var.port
  to_port                      = var.port
  referenced_security_group_id = each.value
}

# Saída: HTTPS (AWS por endpoint/NAT, IdP, backend OTLP) e as portas internas da VPC listadas.
# trivy:ignore:AVD-AWS-0104 HTTPS de saída pelo NAT é necessário (SES, IdP OIDC, OTLP); dados ficam na VPC.
resource "aws_vpc_security_group_egress_rule" "https" {
  count = var.allow_https_egress ? 1 : 0

  security_group_id = aws_security_group.this.id
  description       = "HTTPS de saida (NAT e VPC endpoints)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "vpc" {
  for_each = toset([for port in var.egress_vpc_ports : tostring(port)])

  security_group_id = aws_security_group.this.id
  description       = "Porta ${each.key} dentro da VPC"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  cidr_ipv4         = var.vpc_cidr_block
}

resource "aws_vpc_security_group_egress_rule" "prefix_list" {
  for_each = toset(var.egress_prefix_list_ids)

  security_group_id = aws_security_group.this.id
  description       = "HTTPS para o prefix list (S3 pelo gateway endpoint)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = each.value
}

resource "aws_ecs_service" "this" {
  count = var.create_service ? 1 : 0

  name                   = var.name
  cluster                = var.cluster_arn
  task_definition        = aws_ecs_task_definition.this.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = var.target_group_arn == null ? null : 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn == null ? [] : [1]
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.container_name
      container_port   = var.port
    }
  }

  dynamic "service_connect_configuration" {
    for_each = var.service_connect_namespace_arn == null ? [] : [1]
    content {
      enabled   = true
      namespace = var.service_connect_namespace_arn

      dynamic "service" {
        for_each = local.port_names
        content {
          port_name      = service.value
          discovery_name = var.container_name
          client_alias {
            port     = var.port
            dns_name = var.container_name
          }
        }
      }
    }
  }

  lifecycle {
    # O pipeline (deploy-ecs.ts) troca a revisão; o autoscaling, a contagem.
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  count = var.create_service && var.max_count > var.desired_count ? 1 : 0

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  min_capacity       = var.desired_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  count = length(aws_appautoscaling_target.this)

  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
