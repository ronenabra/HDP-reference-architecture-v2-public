resource "aws_security_group" "web_alb" {
  name        = "${local.name_prefix}-web-alb"
  description = "Browser-facing HTTP access for HDP pcm-connectathon UI"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "Team UI listener ports"
    from_port   = 3000
    to_port     = 8999
    protocol    = "tcp"
    cidr_blocks = var.allowed_web_cidrs
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-web-alb"
  })
}

resource "aws_security_group" "task" {
  name        = "${local.name_prefix}-task"
  description = "Fargate task access for HDP pcm-connectathon team services"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "Browser UI traffic from shared ALB"
    from_port       = 3001
    to_port         = 3002
    protocol        = "tcp"
    security_groups = [aws_security_group.web_alb.id]
  }

  ingress {
    description = "NLB TCP passthrough; task listeners enforce the selected TLS or mTLS policy"
    from_port   = 3000
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = var.allowed_mtls_cidrs
  }

  ingress {
    description = "In-task service traffic"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    self        = true
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-task"
  })
}

resource "aws_security_group" "efs" {
  name        = "${local.name_prefix}-efs"
  description = "EFS access from HDP pcm-connectathon tasks"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "NFS from Fargate tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }

  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-efs"
  })
}
