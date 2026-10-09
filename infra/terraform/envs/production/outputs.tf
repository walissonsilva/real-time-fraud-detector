output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}
output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}
output "ecs_service" {
  value = aws_ecs_service.app.name
}
output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.family
}
output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}
output "migrate_security_group_id" {
  value = aws_security_group.migrate.id
}
output "loadtest_task_definition" {
  value = try(aws_ecs_task_definition.loadtest[0].family, null)
}
output "loadtest_security_group_id" {
  value = try(aws_security_group.loadtest[0].id, null)
}
output "transactions_queue_url" {
  value = aws_sqs_queue.transactions.url
}
output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
output "log_groups" {
  value = [aws_cloudwatch_log_group.app.name, aws_cloudwatch_log_group.migrate.name]
}
