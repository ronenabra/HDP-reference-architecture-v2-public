output "aws_config" {
  description = "Configuration object consumed by pcm-connectathon/aws/scripts/deploy-team-environment.js."
  sensitive   = true
  value       = local.aws_config
}

output "aws_config_json" {
  description = "JSON form of aws_config for writing directly to an aws-env file."
  sensitive   = true
  value       = jsonencode(local.aws_config)
}

output "public_urls" {
  description = "Public URLs to put in team config and use for validation."
  value       = local.public_base_urls
}

output "team_runtime_access_point_id" {
  description = "EFS access point for this team's /runtime directory."
  value       = aws_efs_access_point.team.id
}
