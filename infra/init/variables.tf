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

  # At most 15 characters: the builds bucket's name prefix
  # ("incognitochat-<environment>-builds-", lambda_signing.tf) may have at
  # most 37.
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,14}$", var.github_environment))
    error_message = "github_environment must be 2-15 lowercase letters or digits, starting with a letter (e.g. dev, production)."
  }
}

variable "existing_function_roles" {
  description = "Functions (api, bot, ws, notify) whose roles exist but aren't in this stack's state: the app stack created them before they moved here, so they are imported. scripts/bootstrap.sh fills it in"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for f in var.existing_function_roles : contains(["api", "bot", "ws", "notify"], f)])
    error_message = "existing_function_roles may only name api, bot, ws and notify."
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

# The alarms on the api function's request counts (alerts.tf), each over an
# hour. The defaults are guesses far above an early deployment's use: check
# them against the metrics once real use has run a week or two. They are low
# enough for a campaign of many accounts, each within its own limits:
# 5,000 accounts set up over a week is about 30 an hour.
variable "registrations_alarm" {
  description = "Successful POST /register in an hour above which an alarm is raised: new accounts, and accounts set up again (a retried registration counts again)"
  type        = number
  default     = 20

  validation {
    condition     = var.registrations_alarm > 0
    error_message = "registrations_alarm must be positive."
  }
}

variable "token_requests_alarm" {
  description = "Successful POST /tokens and POST /tokens/media together in an hour above which an alarm is raised. The app asks for 20 send tokens or 30 media tokens at a time, so 200 is about 4,000 send tokens; a person may take 1,000 a day"
  type        = number
  default     = 200

  validation {
    condition     = var.token_requests_alarm > 0
    error_message = "token_requests_alarm must be positive."
  }
}

variable "limit_hits_alarm" {
  description = "429 answers from the api function (rate_limited and daily_limit, every route) in an hour above which an alarm is raised. The limits sit above real use, so real users seldom meet them"
  type        = number
  default     = 100

  validation {
    condition     = var.limit_hits_alarm > 0
    error_message = "limit_hits_alarm must be positive."
  }
}

variable "refusals_alarm" {
  description = "Requests refused in an hour above which an alarm is raised, separately for each of invalid_token (send or media token), init_data_rejected (Telegram data) and signature_rejected (device signature)"
  type        = number
  default     = 50

  validation {
    condition     = var.refusals_alarm > 0
    error_message = "refusals_alarm must be positive."
  }
}

# The tables' caps as the app stack sets them (../variables.tf, GitHub
# variables TABLE_MAX_READ_UNITS and TABLE_MAX_WRITE_UNITS), with the same
# defaults by environment, for the alarms on the capacity the tables use
# (alerts.tf). They must match: where those GitHub variables are set, set
# these to the same values (TF_VAR_table_max_read_units,
# TF_VAR_table_max_write_units), or the alarms fire at another share of
# the caps.
variable "table_max_read_units" {
  description = "Each table's cap on read request units a second, as the app stack sets it (GitHub variable TABLE_MAX_READ_UNITS). Unset (null), 400 in production and 200 elsewhere, as there"
  type        = number
  default     = null

  validation {
    condition     = coalesce(var.table_max_read_units, 1) >= 1 && coalesce(var.table_max_read_units, 1) <= 3000
    error_message = "table_max_read_units must be from 1 to 3,000, as in the app stack."
  }
}

variable "table_max_write_units" {
  description = "Each table's cap on write request units a second, as the app stack sets it (GitHub variable TABLE_MAX_WRITE_UNITS). Unset (null), 200 in production and 100 elsewhere, as there"
  type        = number
  default     = null

  validation {
    condition     = coalesce(var.table_max_write_units, 1) >= 1 && coalesce(var.table_max_write_units, 1) <= 1000
    error_message = "table_max_write_units must be from 1 to 1,000, as in the app stack."
  }
}

variable "table_capacity_alarm_percent" {
  description = "Share of a table's read or write cap, in percent, above which the units it used over 5 minutes raise an alarm, before the cap refuses anyone"
  type        = number
  default     = 70

  validation {
    condition     = var.table_capacity_alarm_percent > 0 && var.table_capacity_alarm_percent <= 100
    error_message = "table_capacity_alarm_percent must be above 0 and at most 100."
  }
}

variable "ws_errors_alarm" {
  description = "WebSocket requests refused in 5 minutes above which an alarm is raised, separately for those API Gateway refused before the ws function ran (ClientError: mostly its throttle) and those ws refused or failed (IntegrationError). 300 is 1 a second"
  type        = number
  default     = 300

  validation {
    condition     = var.ws_errors_alarm > 0
    error_message = "ws_errors_alarm must be positive."
  }
}

variable "media_stored_gib_alarm" {
  description = "GiB held in the media bucket above which an alarm is raised (S3 measures it once a day). 50 GiB costs about $1.15 a month at $0.023 per GB; one account may upload 500 MiB a day, and uploads nobody fetches stay 30 days"
  type        = number
  default     = 50

  validation {
    condition     = var.media_stored_gib_alarm > 0
    error_message = "media_stored_gib_alarm must be positive."
  }
}

variable "firewall" {
  description = "Whether the app stack puts its firewall (AWS WAF) in front of CloudFront (GitHub variable FIREWALL), for the alarm on the requests it blocks. Unset (null), true in production only. Must be true wherever the firewall is on, or nothing alarms on its blocks"
  type        = bool
  default     = null
}

variable "edge_5xx_rate_alarm" {
  description = "Share of CloudFront's answers, in percent, that may be 5xx errors before an alarm is raised. It must be passed in 3 periods of 5 minutes in a row, as the share is noisy while traffic is low"
  type        = number
  default     = 5

  validation {
    condition     = var.edge_5xx_rate_alarm > 0 && var.edge_5xx_rate_alarm <= 100
    error_message = "edge_5xx_rate_alarm must be above 0 and at most 100."
  }
}

variable "firewall_blocks_alarm" {
  description = "Requests the firewall blocked in 5 minutes above which an alarm is raised (3000 is 10 a second). CloudFront and the firewall still bill each blocked request"
  type        = number
  default     = 3000

  validation {
    condition     = var.firewall_blocks_alarm > 0
    error_message = "firewall_blocks_alarm must be positive."
  }
}
