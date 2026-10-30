output "key_arns" {
  description = "ARN da CMK por finalidade."
  value       = { for purpose, key in aws_kms_key.this : purpose => key.arn }
}

output "key_ids" {
  description = "Id da CMK por finalidade."
  value       = { for purpose, key in aws_kms_key.this : purpose => key.key_id }
}
