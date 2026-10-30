variable "environment" {
  description = "Ambiente desta conta AWS: staging ou production (o mesmo nome do ambiente do GitHub)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use staging ou production."
  }
}

variable "github_repository" {
  description = "Repositório (dono/nome) autorizado a assumir os papéis."
  type        = string
  default     = "contrataflow/contrataflow"
}

variable "plan_on_pull_request" {
  description = "PRs podem rodar `terraform plan` (leitura). Ligue só em staging: o plan lê o estado."
  type        = bool
  default     = false
}
