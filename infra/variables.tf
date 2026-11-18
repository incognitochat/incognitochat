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

# The generated secrets (parameters.tf) each have a version of their own:
# raising one writes a new random value for that secret alone, at the next
# deploy. Any change writes one, so a raised version must stay set: unset
# is 1 again, which replaces the secret again. What each change does is in
# docs/deployment.md (Replacing a generated secret). They replace
# SECRETS_VERSION, which changed all four at once and was 1 while unset, as
# each of these is; the deploy now stops while it is set.
variable "session_key_version" {
  description = "Increase to replace the session key: every session ends and apps log in again by themselves; for up to about half an hour open apps get no pushes (they poll, and accounts with notices on get a Telegram notice)"
  type        = number
  default     = 1
  nullable    = false
}

variable "webhook_secret_version" {
  description = "Increase to replace the webhook secret; the same deploy registers the webhook again with it"
  type        = number
  default     = 1
  nullable    = false
}

variable "chat_key_version" {
  description = "Increase to replace the chat key, which seals the chat IDs notices go to: each account's next notice isn't sent and turns its notices off, until the app sets them up again the next time the user opens it"
  type        = number
  default     = 1
  nullable    = false
}

variable "telegram_id_pepper_version" {
  description = "Only to start over; undone only by hand, from SSM's history. Increase to replace the Telegram-ID pepper: no stored Telegram hash matches again, so existing accounts can never turn notices on again, admins lose admin, and a user setting up again gets a second account instead of replacing the first"
  type        = number
  default     = 1
  nullable    = false
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

  validation {
    condition     = var.firewall_anonymous_rate_limit <= var.firewall_rate_limit
    error_message = "firewall_anonymous_rate_limit must be at most firewall_rate_limit, which counts the same requests and more."
  }
}

variable "firewall_lookups_total_limit" {
  description = "Requests everyone together may make in 1 minute to look up links and uploads by ID (edge.tf) before the firewall blocks those lookups for everyone. Unset (null), 30 times the tables' read cap (12,000 in production): each lookup takes at most one read unit, so at most half a table's reads. Set, it must be at most that. GitHub variable FIREWALL_LOOKUPS_TOTAL_LIMIT"
  type        = number
  default     = null

  validation {
    condition     = coalesce(var.firewall_lookups_total_limit, 1000) >= 1000
    error_message = "firewall_lookups_total_limit must be at least 1000."
  }
}

variable "reserve_concurrency" {
  description = "Reserve each function's share of the account's concurrent executions (infra/functions.tf), a guard against floods. Needs a Lambda concurrency quota of at least 235: AWS keeps 100 unreserved, and new accounts start at 10"
  type        = bool
  default     = false
}

# The tables' caps (tables.tf). Unset, they depend on the environment, so
# that nothing needs setting by hand: 400 reads and 200 writes a second in
# production, 200 and 100 elsewhere (dev has no firewall and a small
# budget). A table refuses requests past its caps, at no cost (the
# table-throttles alarms in infra/init fire), so the caps bound the bill: at
# eu-west-1's on-demand prices, all three tables held at both caps cost
# about $51 a day in production, $26 elsewhere (docs/deployment.md, Cost
# guards).
variable "table_max_read_units" {
  description = "Per-table cap on on-demand read request units per second, a cost guard. Unset (null), 400 in production and 200 elsewhere; at most 3,000. GitHub variable TABLE_MAX_READ_UNITS"
  type        = number
  default     = null

  # At most 3,000, what DynamoDB lets one partition read: sends to mailboxes
  # that don't exist all read the same placeholder device in the directory
  # (backend/internal/directory), as table_max_write_units below.
  validation {
    condition     = coalesce(var.table_max_read_units, 1) >= 1 && coalesce(var.table_max_read_units, 1) <= 3000
    error_message = "table_max_read_units must be from 1 to 3,000."
  }
}

variable "table_max_write_units" {
  description = "Per-table cap on on-demand write request units per second, a cost guard. Unset (null), 200 in production and 100 elsewhere; at most 1,000. GitHub variable TABLE_MAX_WRITE_UNITS"
  type        = number
  default     = null

  # At most 1,000, what DynamoDB lets one partition take: sends to mailboxes
  # that don't exist all write the same few placeholder items in the
  # messages table (backend/internal/inbox), one per envelope size. Under a
  # higher cap, a flood of them would be throttled at the placeholder's
  # partition before real deliveries were at the table's cap, which a sender
  # could tell apart.
  validation {
    condition     = coalesce(var.table_max_write_units, 1) >= 1 && coalesce(var.table_max_write_units, 1) <= 1000
    error_message = "table_max_write_units must be from 1 to 1,000."
  }
}

variable "ws_throttle_rate_limit" {
  description = "Steady-state requests per second allowed on the WebSocket API. GitHub variable WS_THROTTLE_RATE_LIMIT"
  type        = number
  default     = 20

  validation {
    condition     = var.ws_throttle_rate_limit >= 1
    error_message = "ws_throttle_rate_limit must be at least 1."
  }
}

variable "ws_throttle_burst_limit" {
  description = "Burst of requests allowed on the WebSocket API. GitHub variable WS_THROTTLE_BURST_LIMIT"
  type        = number
  default     = 40

  validation {
    condition     = var.ws_throttle_burst_limit >= 1
    error_message = "ws_throttle_burst_limit must be at least 1."
  }
}
