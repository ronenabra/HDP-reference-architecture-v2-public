variable "region" {
  description = "AWS region for the shared pcm-connectathon baseline."
  type        = string
  default     = "il-central-1"
}

variable "project_name" {
  description = "Short name used as a prefix for shared AWS resources."
  type        = string
  default     = "hdp-pcm-connectathon"
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated shared pcm-connectathon VPC."
  type        = string
  default     = "10.70.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs. The first three are mapped to the first three AZs."
  type        = list(string)
  default     = ["10.70.0.0/20", "10.70.16.0/20", "10.70.32.0/20"]
}

variable "image_tag" {
  description = "Container image tag used by generated team deployment config."
  type        = string
  default     = "0.1.2"
}

variable "allowed_web_cidrs" {
  description = "CIDR ranges allowed to access browser-facing ALB HTTP endpoints."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "allowed_mtls_cidrs" {
  description = "CIDR ranges allowed to access public mTLS/TCP endpoints through the NLB."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
