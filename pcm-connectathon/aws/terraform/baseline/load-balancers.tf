resource "aws_lb" "web" {
  name               = substr("${local.name_prefix}-web", 0, 32)
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.web_alb.id]
  subnets            = aws_subnet.public[*].id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-web"
  })
}

resource "aws_lb" "mtls" {
  name                             = substr("${local.name_prefix}-mtls", 0, 32)
  load_balancer_type               = "network"
  internal                         = false
  subnets                          = aws_subnet.public[*].id
  enable_cross_zone_load_balancing = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-mtls"
  })
}
