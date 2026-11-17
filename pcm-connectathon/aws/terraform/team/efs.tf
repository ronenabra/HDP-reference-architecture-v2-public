resource "aws_efs_access_point" "team" {
  file_system_id = local.baseline.efsFileSystemId

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/teams/${var.team_id}"

    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }

  tags = merge(local.common_tags, {
    Name = local.name
  })
}
