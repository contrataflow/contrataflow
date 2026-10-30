variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "cidr_block" {
  description = "Bloco /16 da VPC."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zones" {
  description = "Três AZs da região (sa-east-1a/b/c)."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 3
    error_message = "A topologia exige três AZs."
  }
}

variable "nat_gateway_per_az" {
  description = "Um NAT por AZ (produção). false = um NAT só, mais barato e sem redundância de saída."
  type        = bool
  default     = true
}

variable "logs_kms_key_arn" {
  description = "CMK de logs (flow logs)."
  type        = string
}

variable "log_retention_days" {
  description = "Retenção dos flow logs."
  type        = number
  default     = 365
}
