locals {
  name_prefix = var.project_name
  az_count    = min(3, length(data.aws_availability_zones.available.names), length(var.public_subnet_cidrs))
  az_names    = slice(data.aws_availability_zones.available.names, 0, local.az_count)

  common_tags = {
    Project = var.project_name
    Managed = "terraform"
    Scope   = "shared"
  }

  repository_names = {
    pcm_core        = "${local.name_prefix}-pcm-core"
    sp_client       = "${local.name_prefix}-sp-client"
    ds_gateway      = "${local.name_prefix}-ds-gateway"
    ds_auth_adapter = "${local.name_prefix}-ds-auth-adapter"
    ds_fhir_server  = "${local.name_prefix}-ds-fhir-server"
  }

  image_uris = {
    pcmCore       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.pcm_core}:${var.image_tag}"
    spClient      = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.sp_client}:${var.image_tag}"
    dsGateway     = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.ds_gateway}:${var.image_tag}"
    dsAuthAdapter = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.ds_auth_adapter}:${var.image_tag}"
    dsFhirServer  = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_names.ds_fhir_server}:${var.image_tag}"
  }

  baseline_config = {
    region               = var.region
    projectName          = var.project_name
    cluster              = aws_ecs_cluster.this.name
    efsFileSystemId      = aws_efs_file_system.runtime.id
    taskExecutionRoleArn = aws_iam_role.task_execution.arn
    taskRoleArn          = aws_iam_role.task.arn
    subnets              = aws_subnet.public[*].id
    securityGroups       = [aws_security_group.task.id]
    assignPublicIp       = true
    logGroup             = aws_cloudwatch_log_group.ecs.name
    images               = local.image_uris
    webLoadBalancer = {
      arn     = aws_lb.web.arn
      dnsName = aws_lb.web.dns_name
      zoneId  = aws_lb.web.zone_id
      name    = aws_lb.web.name
    }
    mtlsLoadBalancer = {
      arn     = aws_lb.mtls.arn
      dnsName = aws_lb.mtls.dns_name
      zoneId  = aws_lb.mtls.zone_id
      name    = aws_lb.mtls.name
    }
    vpcId = aws_vpc.this.id
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
