data "terraform_remote_state" "baseline_local" {
  count   = var.baseline_state_backend == "local" ? 1 : 0
  backend = "local"

  config = {
    path = var.baseline_state_path
  }
}

data "terraform_remote_state" "baseline_s3" {
  count   = var.baseline_state_backend == "s3" ? 1 : 0
  backend = "s3"

  config = {
    bucket = var.baseline_state_bucket
    key    = var.baseline_state_key
    region = var.baseline_state_region
  }
}

locals {
  baseline  = var.baseline_state_backend == "s3" ? data.terraform_remote_state.baseline_s3[0].outputs.baseline_config : data.terraform_remote_state.baseline_local[0].outputs.baseline_config
  name      = "${var.service_prefix}-${var.team_id}"
  tg_prefix = "${substr(local.name, 0, 20)}-${substr(md5(local.name), 0, 6)}"
  web_dns   = local.baseline.webLoadBalancer.dnsName
  mtls_dns  = local.baseline.mtlsLoadBalancer.dnsName
  common_tags = {
    Project = var.service_prefix
    TeamId  = var.team_id
    Managed = "terraform"
    Scope   = "team"
  }

  public_base_urls = {
    spClient            = "http://${local.web_dns}:${var.sp_ui_public_port}"
    pcmUi               = "http://${local.web_dns}:${var.pcm_ui_public_port}"
    pcmApi              = "https://${local.mtls_dns}:${var.pcm_api_public_port}"
    pcmMetadata         = "https://${local.mtls_dns}:${var.pcm_metadata_public_port}"
    referenceDataSource = "https://${local.mtls_dns}:${var.ds_gateway_public_port}/fhir"
    dataSourceMetadata  = "https://${local.mtls_dns}:${var.ds_gateway_public_port}"
  }

  aws_config = {
    region               = var.region
    cluster              = local.baseline.cluster
    servicePrefix        = var.service_prefix
    efsFileSystemId      = local.baseline.efsFileSystemId
    efsAccessPointId     = aws_efs_access_point.team.id
    taskExecutionRoleArn = local.baseline.taskExecutionRoleArn
    taskRoleArn          = local.baseline.taskRoleArn
    subnets              = local.baseline.subnets
    securityGroups       = local.baseline.securityGroups
    assignPublicIp       = true
    cpu                  = var.cpu
    memory               = var.memory
    desiredCount         = var.desired_count
    logGroup             = local.baseline.logGroup
    teamAdminPassword    = var.team_admin_password
    publicBaseUrls       = local.public_base_urls
    images               = local.baseline.images
    loadBalancers = [
      {
        targetGroupArn = aws_lb_target_group.sp_client.arn
        containerName  = "sp-client"
        containerPort  = 3002
      },
      {
        targetGroupArn = aws_lb_target_group.pcm_ui.arn
        containerName  = "pcm-core"
        containerPort  = 3001
      },
      {
        targetGroupArn = aws_lb_target_group.pcm_api.arn
        containerName  = "pcm-core"
        containerPort  = 3000
      },
      {
        targetGroupArn = aws_lb_target_group.pcm_metadata.arn
        containerName  = "pcm-core"
        containerPort  = 3005
      },
      {
        targetGroupArn = aws_lb_target_group.ds_gateway.arn
        containerName  = "ds-gateway"
        containerPort  = 8080
      }
    ]
  }
}
