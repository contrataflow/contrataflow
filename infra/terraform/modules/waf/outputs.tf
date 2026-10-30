output "web_acl_arn" {
  description = "Web ACL."
  value       = aws_wafv2_web_acl.this.arn
}
