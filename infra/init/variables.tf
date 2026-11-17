variable "aws_region" {
  description = "AWS region for the state bucket and the app resources the deploy role may manage"
  type        = string
}

variable "state_bucket_name" {
  description = "Name of the S3 bucket that stores Terraform state for both stacks"
  type        = string
}

variable "github_oidc_subject_prefix" {
  description = <<-EOT
    Prefix of the OIDC "sub" claim GitHub issues for this repository, as reported by
    GET /repos/<owner>/<repo>/actions/oidc/customization/sub (sub_claim_prefix):
    "repo:<owner>/<repo>", or with immutable subjects "repo:<owner>@<owner-id>/<repo>@<repo-id>".
    scripts/bootstrap.sh looks it up so it always matches what GitHub actually sends.
  EOT
  type        = string

  validation {
    condition     = can(regex("^repo:[^:]+/[^:]+$", var.github_oidc_subject_prefix))
    error_message = "github_oidc_subject_prefix must look like repo:<owner>/<repo> (optionally with @<id> suffixes)."
  }
}

variable "github_environment" {
  description = "GitHub environment whose jobs may assume the deploy role. It also names every resource (incognitochat-<environment>-…)."
  type        = string
  default     = "production"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,15}$", var.github_environment))
    error_message = "github_environment must be 2-16 lowercase letters or digits, starting with a letter (e.g. dev, production)."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget for the account, in US dollars (default: 50 for production, 15 otherwise). Alerts go out at half of it, at all of it, and when the month is forecast to pass it"
  type        = number
  default     = null

  validation {
    condition     = var.monthly_budget_usd == null || try(var.monthly_budget_usd > 0, false)
    error_message = "monthly_budget_usd must be positive."
  }
}

variable "api_invocations_alarm" {
  description = "Calls to the api function in 5 minutes above which an alarm is raised (30000 is 100 a second)"
  type        = number
  default     = 30000
}

variable "media_requests_alarm" {
  description = "Uploads (PUT) or downloads (GET) straight to the media bucket in 5 minutes above which an alarm is raised (3000 is 10 a second)"
  type        = number
  default     = 3000
}

variable "media_download_gib_alarm" {
  description = "GiB downloaded from the media bucket in 5 minutes above which an alarm is raised (2 GiB is about 7 MB a second, about $0.19 of data transfer at $0.09 per GB)"
  type        = number
  default     = 2

  validation {
    condition     = var.media_download_gib_alarm > 0
    error_message = "media_download_gib_alarm must be positive."
  }
}
