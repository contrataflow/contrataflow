variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "name" {
  description = "Nome do serviço e da família da task definition (`<ECS_SERVICE_PREFIX>-<app>`)."
  type        = string
}

variable "container_name" {
  description = "Nome do contêiner (`api`, `web`, `worker`, `migrator`…)."
  type        = string
}

variable "image" {
  description = "Imagem inicial. O pipeline troca pela imagem assinada, por digest, a cada deploy."
  type        = string
}

variable "command" {
  description = "Comando do contêiner (null = o CMD da imagem)."
  type        = list(string)
  default     = null
}

variable "user" {
  description = "Usuário do processo (null = o USER da imagem, sempre não-root)."
  type        = string
  default     = "node"
}

variable "cpu" {
  description = "CPU da task (unidades)."
  type        = number
}

variable "memory" {
  description = "Memória da task (MiB)."
  type        = number
}

variable "cpu_architecture" {
  description = "X86_64 ou ARM64 (Graviton, quando as imagens forem multi-arquitetura)."
  type        = string
  default     = "X86_64"
}

variable "port" {
  description = "Porta do contêiner (null = sem porta, ex.: worker e migração)."
  type        = number
  default     = null
}

variable "environment_variables" {
  description = "Variáveis de ambiente não secretas."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Variável → `valueFrom` (ARN do segredo, com `:CHAVE::` para JSON)."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "ARNs dos segredos que o papel de execução pode ler."
  type        = list(string)
  default     = []
}

variable "secrets_kms_key_arn" {
  description = "CMK `secrets`."
  type        = string
}

variable "ecr_repository_arns" {
  description = "Repositórios de onde a task puxa a imagem."
  type        = list(string)
  default     = ["*"]
}

variable "task_policy_json" {
  description = "Política do papel da task (null = nenhuma permissão AWS)."
  type        = string
  default     = null
}

variable "readonly_root_filesystem" {
  description = "Raiz somente leitura (security.md §17)."
  type        = bool
  default     = true
}

variable "writable_paths" {
  description = "Diretórios graváveis (volumes efêmeros da task)."
  type        = list(string)
  default     = ["/tmp"]
}

variable "health_check_command" {
  description = "Comando do healthcheck do contêiner (CMD-SHELL); null = sem healthcheck."
  type        = string
  default     = null
}

variable "logs_kms_key_arn" {
  description = "CMK de logs."
  type        = string
}

variable "log_retention_days" {
  description = "Retenção dos logs do contêiner."
  type        = number
  default     = 90
}

variable "create_service" {
  description = "false = só a task definition (task one-off de migração)."
  type        = bool
  default     = true
}

variable "cluster_arn" {
  description = "Cluster ECS."
  type        = string
  default     = null
}

variable "cluster_name" {
  description = "Nome do cluster (autoscaling)."
  type        = string
  default     = null
}

variable "vpc_id" {
  description = "VPC."
  type        = string
}

variable "vpc_cidr_block" {
  description = "Bloco da VPC (saída para portas internas)."
  type        = string
}

variable "subnet_ids" {
  description = "Sub-redes privadas de aplicação."
  type        = list(string)
}

variable "ingress_security_group_ids" {
  description = "SGs que alcançam a porta do app (nome lógico → id)."
  type        = map(string)
  default     = {}
}

variable "allow_https_egress" {
  description = "Permite HTTPS de saída (NAT/VPC endpoints)."
  type        = bool
  default     = true
}

variable "egress_vpc_ports" {
  description = "Portas de saída liberadas só para a VPC (5432, 6379, 4000…)."
  type        = list(number)
  default     = []
}

variable "egress_prefix_list_ids" {
  description = "Prefix lists liberados em HTTPS (ex.: S3 do gateway endpoint, para puxar camadas do ECR)."
  type        = list(string)
  default     = []
}

variable "desired_count" {
  description = "Tasks mínimas."
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Teto do autoscaling por CPU."
  type        = number
  default     = 2
}

variable "target_group_arn" {
  description = "Target group do ALB (null = sem exposição pública)."
  type        = string
  default     = null
}

variable "service_connect_namespace_arn" {
  description = "Namespace do Service Connect (descoberta interna `http://<contêiner>:<porta>`)."
  type        = string
  default     = null
}
