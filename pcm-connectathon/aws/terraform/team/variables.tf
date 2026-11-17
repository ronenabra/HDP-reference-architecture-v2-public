variable "region" {
  description = "AWS region for this team deployment."
  type        = string
  default     = "il-central-1"
}

variable "baseline_state_path" {
  description = "Path to the shared baseline Terraform state file when baseline_state_backend is local."
  type        = string
  default     = "../baseline/terraform.tfstate"
}

variable "baseline_state_backend" {
  description = "Terraform remote state backend used to read the shared baseline outputs."
  type        = string
  default     = "local"

  validation {
    condition     = contains(["local", "s3"], var.baseline_state_backend)
    error_message = "baseline_state_backend must be local or s3."
  }
}

variable "baseline_state_bucket" {
  description = "S3 bucket containing baseline Terraform state when baseline_state_backend is s3."
  type        = string
  default     = ""
}

variable "baseline_state_key" {
  description = "S3 object key for baseline Terraform state when baseline_state_backend is s3."
  type        = string
  default     = "pcm-connectathon/baseline/terraform.tfstate"
}

variable "baseline_state_region" {
  description = "AWS region for the S3 bucket containing baseline Terraform state."
  type        = string
  default     = "il-central-1"
}

variable "team_id" {
  description = "Team identifier used in resource names and runtime paths."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.team_id))
    error_message = "team_id must match /^[a-z0-9][a-z0-9-]*$/."
  }
}

variable "service_prefix" {
  description = "Prefix used by deploy-team-environment.js to derive ECS service names."
  type        = string
  default     = "hdp-pcm-connectathon"
}

variable "cpu" {
  description = "Fargate task CPU units for this team."
  type        = number
  default     = 1024
}

variable "memory" {
  description = "Fargate task memory in MiB for this team."
  type        = number
  default     = 2048
}

variable "desired_count" {
  description = "Desired ECS task count for this team service."
  type        = number
  default     = 1
}

variable "team_admin_password" {
  description = "Admin password passed to this team's task."
  type        = string
  default     = "change-me"
  sensitive   = true
}

variable "sp_ui_public_port" {
  description = "Shared ALB listener port for this team's Service Provider UI."
  type        = number
}

variable "pcm_ui_public_port" {
  description = "Shared ALB listener port for this team's PCM UI/Admin UI."
  type        = number
}

variable "pcm_api_public_port" {
  description = "Shared NLB listener port for this team's PCM API mTLS endpoint."
  type        = number
}

variable "pcm_metadata_public_port" {
  description = "Shared NLB TCP listener port for this team's PCM metadata endpoint; the task enforces strict mTLS."
  type        = number
}

variable "ds_gateway_public_port" {
  description = "Shared NLB listener port for this team's reference Data Source gateway mTLS endpoint."
  type        = number
}
