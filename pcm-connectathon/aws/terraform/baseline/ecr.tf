resource "aws_ecr_repository" "service" {
  for_each = local.repository_names

  name                 = each.value
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Name    = each.value
    Service = each.key
  })
}
