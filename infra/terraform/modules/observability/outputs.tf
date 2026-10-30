output "alarm_topic_arn" {
  description = "Tópico SNS dos alarmes."
  value       = aws_sns_topic.alarms.arn
}
