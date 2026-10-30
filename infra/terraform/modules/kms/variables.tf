variable "environment" {
  description = "Ambiente lógico (staging ou production)."
  type        = string
}

variable "purposes" {
  description = "Finalidades das CMKs (architecture.md §11.2)."
  type        = list(string)
  default     = ["storage", "rds", "app-fields", "secrets", "logs"]
}
