output "baseline_config" {
  description = "Shared baseline values consumed by the per-team Terraform layer."
  value       = local.baseline_config
}

output "baseline_config_json" {
  description = "JSON form of baseline_config."
  value       = jsonencode(local.baseline_config)
}

output "ecr_images" {
  description = "Shared ECR image URIs used by all teams."
  value       = local.image_uris
}

output "load_balancer_dns" {
  description = "Shared AWS load balancer DNS names."
  value = {
    web  = aws_lb.web.dns_name
    mtls = aws_lb.mtls.dns_name
  }
}
