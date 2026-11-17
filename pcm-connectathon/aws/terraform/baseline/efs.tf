resource "aws_efs_file_system" "runtime" {
  creation_token   = "${local.name_prefix}-runtime"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-runtime"
  })
}

resource "aws_efs_mount_target" "runtime" {
  count = local.az_count

  file_system_id  = aws_efs_file_system.runtime.id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.efs.id]
}
