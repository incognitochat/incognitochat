# A deploy writes a generated secret again only when its version changes.
# The version (local.parameter_versions, parameters.tf) is the SSM
# parameter's value_wo_version, and goes into PARAMS_VERSION in the
# environment of each function that reads the parameter (functions.tf),
# which replaces the function's warm instances. Nothing else replaces a
# secret: the values are ephemeral, made afresh on every run.
#
# The four generated secrets once shared SECRETS_VERSION, which the deploy
# passed as 1 while unset (and now stops while it is set). With no version
# set, each must still be 1, so the deploy that gave each secret its own
# version writes none of them and changes no PARAMS_VERSION; and raising
# one secret's version must change that secret's alone, the pepper's
# included. Plans only: the provider has fake credentials and makes no
# calls. The functions themselves can't be planned here (they need the
# built bundles), so PARAMS_VERSION is covered through the versions it is
# built from. Run by CI (terraform test).

provider "aws" {
  region                      = "eu-west-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

variables {
  aws_region  = "eu-west-1"
  environment = "test"
  bot_token   = "1:test"
  # Not keys; built so that secret scanners don't take them for ones.
  issuer_key                     = format("-----BEGIN %s-----\nAAAA\n-----END %s-----\n", "PRIVATE KEY", "PRIVATE KEY")
  media_issuer_key               = format("-----BEGIN %s-----\nAAAA\n-----END %s-----\n", "PRIVATE KEY", "PRIVATE KEY")
  client_origins                 = ["https://example.github.io"]
  lambda_builds_bucket           = "test"
  lambda_signing_profile         = "test"
  lambda_code_signing_config_arn = "test"
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}

# No version set: every version as it was under SECRETS_VERSION (1).
run "nothing_set_replaces_nothing" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 1
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 1
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 1
      "previous-media-issuer-key" = 1
      "session-key"               = 1
      "telegram-id-pepper"        = 1
      "webhook-secret"            = 1
    })
    error_message = "With no version set, a parameter's version is no longer what it was: the next deploy would replace that secret."
  }
}

run "session_key_alone" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    session_key_version = 2
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 1
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 1
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 1
      "previous-media-issuer-key" = 1
      "session-key"               = 2
      "telegram-id-pepper"        = 1
      "webhook-secret"            = 1
    })
    error_message = "session_key_version must change the session key's version alone."
  }
}

run "webhook_secret_alone" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    webhook_secret_version = 2
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 1
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 1
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 1
      "previous-media-issuer-key" = 1
      "session-key"               = 1
      "telegram-id-pepper"        = 1
      "webhook-secret"            = 2
    })
    error_message = "webhook_secret_version must change the webhook secret's version alone."
  }
}

run "chat_key_alone" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    chat_key_version = 2
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 1
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 2
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 1
      "previous-media-issuer-key" = 1
      "session-key"               = 1
      "telegram-id-pepper"        = 1
      "webhook-secret"            = 1
    })
    error_message = "chat_key_version must change the chat key's version alone."
  }
}

run "telegram_id_pepper_alone" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    telegram_id_pepper_version = 2
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 1
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 1
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 1
      "previous-media-issuer-key" = 1
      "session-key"               = 1
      "telegram-id-pepper"        = 2
      "webhook-secret"            = 1
    })
    error_message = "telegram_id_pepper_version must change the pepper's version alone."
  }
}

# The issuer keys' previous keys (docs/deployment.md, Rotating an issuer
# key) came after the rest: with nothing set, each is a parameter at 1 that
# holds "none", and no other version changes (above). Setting a previous
# key, as a rotation does, with its version raised, changes that version
# alone. An unset GitHub secret comes as an empty value, which is none too.
run "previous_issuer_key_alone" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    previous_issuer_key         = format("-----BEGIN %s-----\nAAAB\n-----END %s-----\n", "PRIVATE KEY", "PRIVATE KEY")
    previous_issuer_key_version = 2
    previous_media_issuer_key   = ""
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 1
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 1
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 2
      "previous-media-issuer-key" = 1
      "session-key"               = 1
      "telegram-id-pepper"        = 1
      "webhook-secret"            = 1
    })
    error_message = "previous_issuer_key_version must change the previous send key's version alone."
  }
}

run "previous_media_issuer_key_alone" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    previous_media_issuer_key         = format("-----BEGIN %s-----\nAAAB\n-----END %s-----\n", "PRIVATE KEY", "PRIVATE KEY")
    previous_media_issuer_key_version = 2
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 1
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 1
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 1
      "previous-media-issuer-key" = 2
      "session-key"               = 1
      "telegram-id-pepper"        = 1
      "webhook-secret"            = 1
    })
    error_message = "previous_media_issuer_key_version must change the previous media key's version alone."
  }
}

run "previous_issuer_key_must_be_a_key" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    previous_issuer_key = "not a key"
  }

  expect_failures = [var.previous_issuer_key]
}

# The admins' Telegram IDs came last, from the api function's environment:
# with nothing set, a parameter at 1 that holds "none", which the deploy
# that adds it writes once, as it creates it; and no other version changes
# (above). Changing them, with the version raised, changes that version
# alone. An unset GitHub secret comes as an empty value, which is none.
run "admin_telegram_ids_alone" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    admin_telegram_ids         = "1, 2"
    admin_telegram_ids_version = 2
  }

  assert {
    condition = jsonencode({ for k, p in aws_ssm_parameter.parameter : k => p.value_wo_version }) == jsonencode({
      "admin-telegram-ids"        = 2
      "bot-id"                    = 1
      "bot-token"                 = 1
      "chat-key"                  = 1
      "issuer-key"                = 1
      "media-issuer-key"          = 1
      "previous-issuer-key"       = 1
      "previous-media-issuer-key" = 1
      "session-key"               = 1
      "telegram-id-pepper"        = 1
      "webhook-secret"            = 1
    })
    error_message = "admin_telegram_ids_version must change the admins' version alone."
  }
}

run "admin_telegram_ids_must_be_ids" {
  command = plan

  plan_options {
    target = [aws_ssm_parameter.parameter]
  }

  variables {
    admin_telegram_ids = "42,@admin"
  }

  expect_failures = [var.admin_telegram_ids]
}
