resource "aws_lb_target_group" "sp_client" {
  name        = "${local.tg_prefix}-sp"
  port        = 3002
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.baseline.vpcId

  health_check {
    enabled             = true
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "pcm_ui" {
  name        = "${local.tg_prefix}-ui"
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.baseline.vpcId

  health_check {
    enabled             = true
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "pcm_api" {
  # TCP passthrough preserves the peer TLS session so PCM Core, rather than a
  # spoofable forwarding header, authenticates the client certificate.
  name        = "${local.tg_prefix}-api"
  port        = 3000
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = local.baseline.vpcId

  health_check {
    enabled             = true
    protocol            = "TCP"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "pcm_metadata" {
  # Metadata is part of the same strict public mTLS boundary as the API.
  name        = "${local.tg_prefix}-meta"
  port        = 3005
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = local.baseline.vpcId

  health_check {
    enabled             = true
    protocol            = "TCP"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group" "ds_gateway" {
  name        = "${local.tg_prefix}-ds"
  port        = 8080
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = local.baseline.vpcId

  health_check {
    enabled             = true
    protocol            = "TCP"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "sp_client" {
  load_balancer_arn = local.baseline.webLoadBalancer.arn
  port              = var.sp_ui_public_port
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.sp_client.arn
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "pcm_ui" {
  load_balancer_arn = local.baseline.webLoadBalancer.arn
  port              = var.pcm_ui_public_port
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pcm_ui.arn
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "pcm_api" {
  load_balancer_arn = local.baseline.mtlsLoadBalancer.arn
  port              = var.pcm_api_public_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pcm_api.arn
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "pcm_metadata" {
  load_balancer_arn = local.baseline.mtlsLoadBalancer.arn
  port              = var.pcm_metadata_public_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pcm_metadata.arn
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "ds_gateway" {
  load_balancer_arn = local.baseline.mtlsLoadBalancer.arn
  port              = var.ds_gateway_public_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ds_gateway.arn
  }

  tags = local.common_tags
}
