variable "apps" {
  description = "Apps com imagem própria."
  type        = list(string)
  default     = ["api", "web", "worker"]
}

variable "pull_account_ids" {
  description = "Contas AWS que podem puxar as imagens (ex.: a de produção, promovida sem rebuild)."
  type        = list(string)
  default     = []
}

variable "max_images" {
  description = "Imagens com tag mantidas por repositório (inclui as tags do cosign)."
  type        = number
  default     = 300
}
