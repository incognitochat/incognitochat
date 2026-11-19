# Secrets and settings in SSM Parameter Store (SecureString, standard tier:
# free). Values are generated as ephemeral values or passed in as ephemeral
# variables and written with write-only arguments, so they never appear in
# Terraform state or plan files. Each function role can read only the
# parameters it needs (functions.tf).

# HMAC key for session tokens (api issues them, ws checks them). A key
# derived from it, with a label of its own, names socket records in the
# ephemeral table (ws records and reads them, api forgets an account's), so
# a copy of the table can't be matched with the directory. A new value
# (session_key_version) logs everyone out, and apps log in again by
# themselves; it leaves the old socket records unfound: open apps get no
# push until they replace their sockets (within about half an hour), only
# their polls and, with notices on, a notice; the old records expire within
# 40 minutes.
ephemeral "random_password" "session_key" {
  length  = 64
  special = false
}

# Key for the keyed hash of Telegram user IDs, so the directory can enforce one
# account per Telegram user without storing the IDs themselves. api also
# names its rate counters with it (keyed hashes that change every window).
# A new value (telegram_id_pepper_version) is only for starting over: no
# account's stored hash matches again, and Terraform can't bring the old
# value back (docs/deployment.md says what stops working).
ephemeral "random_password" "telegram_id_pepper" {
  length  = 64
  special = false
}

# Telegram sends it with every webhook update; independent of the bot token.
# A new value (webhook_secret_version) reaches Telegram when the deploy sets
# up the bot, after checking what it deployed and before the smoke tests;
# updates refused meanwhile are sent again.
ephemeral "random_password" "webhook_secret" {
  length  = 64
  special = false
}

# Seals the Telegram chat IDs notices go to; only notify can read it. A key
# derived from it names notify's quiet periods (one notice per account every
# 3 minutes). A new key (chat_key_version) leaves stored chat IDs
# unreadable: each account's next notice isn't sent and turns its notices
# off, until the app sets them up again, which it does when the account says
# they're off (and the quiet periods start afresh).
ephemeral "random_password" "chat_key" {
  length  = 64
  special = false
}

locals {
  # Versions decide when a write-only value is written again: a parameter is
  # written only when its version changes, and that also replaces the warm
  # instances of the functions that read it (functions.tf). Each generated
  # secret has its own, so replacing one leaves the others as they are
  # (infra/tests/secret_versions.tftest.hcl). Kept separate from the values
  # because values are ephemeral and can't drive for_each.
  parameter_versions = {
    "bot-token"          = var.bot_token_version
    "bot-id"             = var.bot_token_version
    "session-key"        = var.session_key_version
    "telegram-id-pepper" = var.telegram_id_pepper_version
    "webhook-secret"     = var.webhook_secret_version
    "chat-key"           = var.chat_key_version
    "issuer-key"         = var.issuer_key_version
    "media-issuer-key"   = var.media_issuer_key_version
    # Each kind's previous issuer key, held only while a rotation lasts
    # (docs/deployment.md, Rotating an issuer key).
    "previous-issuer-key"       = var.previous_issuer_key_version
    "previous-media-issuer-key" = var.previous_media_issuer_key_version
  }

  # The bot ID is the token's numeric prefix. Writing it here means nobody
  # has to read the token to configure it, and the api function can check
  # Telegram's signatures without having access to the token.
  parameter_values = {
    "bot-token"          = var.bot_token
    "bot-id"             = split(":", var.bot_token)[0]
    "session-key"        = ephemeral.random_password.session_key.result
    "telegram-id-pepper" = ephemeral.random_password.telegram_id_pepper.result
    "webhook-secret"     = ephemeral.random_password.webhook_secret.result
    "chat-key"           = ephemeral.random_password.chat_key.result
    "issuer-key"         = var.issuer_key
    "media-issuer-key"   = var.media_issuer_key
    # "none" while there is no previous key (tokens.NoKey in the backend):
    # SSM can't store an empty value.
    "previous-issuer-key"       = coalesce(var.previous_issuer_key, "none")
    "previous-media-issuer-key" = coalesce(var.previous_media_issuer_key, "none")
  }
}

resource "aws_ssm_parameter" "parameter" {
  for_each = local.parameter_versions

  name             = "${local.parameter_path}/${each.key}"
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = local.parameter_values[each.key]
  value_wo_version = each.value
}
