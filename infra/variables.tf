variable "aws_region" {
  description = "AWS region for every resource"
  type        = string
}

variable "environment" {
  description = "Environment name; must match the bootstrap stack (infra/init), which only allows names with this prefix"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lowercase letters or digits, starting with a letter."
  }
}

variable "bot_token" {
  description = "Telegram bot token. Ephemeral: written to SSM, never stored in Terraform state or plan files."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]+:[A-Za-z0-9_-]+$", var.bot_token))
    error_message = "bot_token doesn't look like a Telegram bot token (<digits>:<letters, digits, _ or ->)."
  }
}

variable "issuer_key" {
  description = "Send-token issuer's RSA-2048 private key (PKCS#8 PEM). Ephemeral: written to SSM, never stored in Terraform state or plan files. Its public key is published in web/issuer-keys.json."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false

  validation {
    condition     = can(regex("^-----BEGIN PRIVATE KEY-----\\n[A-Za-z0-9+/=\\n]+-----END PRIVATE KEY-----\\n?$", var.issuer_key))
    error_message = "issuer_key must be a PKCS#8 PEM private key."
  }
}

variable "issuer_key_version" {
  description = "Increase to push a changed issuer key into SSM"
  type        = number
  default     = 1
}

variable "media_issuer_key" {
  description = "Media-token issuer's RSA-2048 private key (PKCS#8 PEM), a different key from issuer_key: media tokens pay for uploads and have their own daily budget. Ephemeral: written to SSM, never stored in Terraform state or plan files. Its public key is published in web/issuer-keys.json."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false

  validation {
    condition     = can(regex("^-----BEGIN PRIVATE KEY-----\\n[A-Za-z0-9+/=\\n]+-----END PRIVATE KEY-----\\n?$", var.media_issuer_key))
    error_message = "media_issuer_key must be a PKCS#8 PEM private key."
  }
}

variable "media_issuer_key_version" {
  description = "Increase to push a changed media issuer key into SSM"
  type        = number
  default     = 1
}

variable "bot_token_version" {
  description = "Increase to push a changed bot token into SSM (write-only values can't be compared with what's stored)"
  type        = number
  default     = 1
}

variable "secrets_version" {
  description = "Increase to replace the generated secrets (session key, Telegram ID pepper, webhook secret). Replacing the pepper starts every account over."
  type        = number
  default     = 1
}

variable "client_origins" {
  description = "Origins allowed to call the HTTPS API from a browser (CORS), e.g. the GitHub Pages origin"
  type        = list(string)

  validation {
    condition     = length(var.client_origins) > 0 && alltrue([for o in var.client_origins : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "client_origins must be a non-empty list of https:// origins without a path."
  }
}

variable "invite_only" {
  description = "While true, only accounts that joined through an invitation, and admins, can own links"
  type        = bool
  default     = true
}

variable "admin_telegram_ids" {
  description = "Comma-separated Telegram user IDs of admins. The api function keeps only their keyed hashes"
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9, ]*$", var.admin_telegram_ids))
    error_message = "admin_telegram_ids must be comma-separated numeric Telegram user IDs."
  }
}

variable "lambda_dir" {
  description = "Directory with the Lambda bundles built by scripts/build-lambdas.sh"
  type        = string
  default     = "../backend/dist"
}

# Code signing, from infra/init (GitHub environment secrets). Sensitive so
# that plans in the public logs don't show them.
variable "lambda_builds_bucket" {
  description = "Versioned bucket the builds are uploaded to for signing"
  type        = string
  sensitive   = true
}

variable "lambda_signing_profile" {
  description = "AWS Signer profile the builds are signed with"
  type        = string
  sensitive   = true
}

variable "lambda_code_signing_config_arn" {
  description = "Code signing config that makes each function run only code signed by that profile"
  type        = string
  sensitive   = true
}

variable "log_retention_days" {
  description = "Retention for function logs"
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Protect the DynamoDB tables from deletion (keep on in production)"
  type        = bool
  default     = true
}

variable "api_access" {
  description = "How the app reaches the API (infra/edge.tf): direct (the function URL), cloudfront (through CloudFront; the function URL still answers), or cloudfront-only (the function URL answers CloudFront alone). Move one step at a time, and update the site's API_URL when the api_url output changes"
  type        = string
  default     = "direct"

  validation {
    condition     = contains(["direct", "cloudfront", "cloudfront-only"], var.api_access)
    error_message = "api_access must be direct, cloudfront or cloudfront-only."
  }
}

variable "firewall" {
  description = "Put a firewall (AWS WAF) in front of CloudFront, with rate limits per IP address and on the routes that need no login (edge.tf). About $8 a month, plus $0.60 per million requests"
  type        = bool
  default     = false
}

variable "firewall_rate_limit" {
  description = "Requests one IP address may make in 5 minutes, to any route, before the firewall blocks it. Many people can share an address (a carrier, a VPN). GitHub variable FIREWALL_RATE_LIMIT"
  type        = number
  default     = 2000

  validation {
    condition     = var.firewall_rate_limit >= 100
    error_message = "firewall_rate_limit must be at least 100."
  }
}

variable "firewall_anonymous_rate_limit" {
  description = "Requests one IP address may make in 5 minutes to the routes that need no login (edge.tf) before the firewall blocks it from those routes. GitHub variable FIREWALL_ANONYMOUS_RATE_LIMIT"
  type        = number
  default     = 500

  validation {
    condition     = var.firewall_anonymous_rate_limit >= 100
    error_message = "firewall_anonymous_rate_limit must be at least 100."
  }
}

variable "firewall_anonymous_total_limit" {
  description = "Requests everyone together may make in 1 minute to the routes that need no login (edge.tf) before the firewall blocks those routes for everyone. Keep it at most 30 times table_max_read_units, so that even at a read unit each they use at most half the directory table's reads, and raise it with the caps. GitHub variable FIREWALL_ANONYMOUS_TOTAL_LIMIT"
  type        = number
  default     = 12000

  validation {
    condition     = var.firewall_anonymous_total_limit >= 1000
    error_message = "firewall_anonymous_total_limit must be at least 1000."
  }
}

variable "reserve_concurrency" {
  description = "Reserve each function's share of the account's concurrent executions (infra/functions.tf), a guard against floods. Needs a Lambda concurrency quota of at least 235: AWS keeps 100 unreserved, and new accounts start at 10"
  type        = bool
  default     = false
}

# A table refuses requests past its caps, at no cost (the table-throttles
# alarms in infra/init fire), so the caps bound the bill: at eu-west-1's
# on-demand prices, a table held at both caps all day costs about $17, all
# three about $51 a day (docs/deployment.md, Cost guards).
variable "table_max_read_units" {
  description = "Per-table cap on on-demand read request units per second, a cost guard. GitHub variable TABLE_MAX_READ_UNITS"
  type        = number
  default     = 400

  validation {
    condition     = var.table_max_read_units >= 1
    error_message = "table_max_read_units must be at least 1."
  }
}

variable "table_max_write_units" {
  description = "Per-table cap on on-demand write request units per second, a cost guard. GitHub variable TABLE_MAX_WRITE_UNITS"
  type        = number
  default     = 200

  validation {
    condition     = var.table_max_write_units >= 1
    error_message = "table_max_write_units must be at least 1."
  }
}

variable "ws_throttle_rate_limit" {
  description = "Steady-state requests per second allowed on the WebSocket API. GitHub variable WS_THROTTLE_RATE_LIMIT"
  type        = number
  default     = 20
}

variable "ws_throttle_burst_limit" {
  description = "Burst of requests allowed on the WebSocket API. GitHub variable WS_THROTTLE_BURST_LIMIT"
  type        = number
  default     = 40
}
