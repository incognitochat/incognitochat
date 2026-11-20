# The account expiry (functions.tf, tables.tf; docs/deployment.md, Account
# expiry): the directory's index of account items by their last-use month,
# keys only, on the directory alone; the schedule that runs it, named with
# the prefix the deploy role may manage rules under (infra/init), disabled
# when the switch is off; the switch, in api's environment, which takes
# off, dry-run or on, dry-run unless set; and api's right to read that
# index, and no other. Plans and rendered policies only: the provider has
# fake credentials and makes no calls. Run by CI (terraform test).

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
  previous_issuer_key            = ""
  previous_media_issuer_key      = ""
  admin_telegram_ids             = ""
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}

override_resource {
  target = aws_dynamodb_table.table["directory"]
  values = { arn = "arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-directory" }
}

override_resource {
  target = aws_dynamodb_table.table["messages"]
  values = { arn = "arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-messages" }
}

override_resource {
  target = aws_dynamodb_table.table["ephemeral"]
  values = { arn = "arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-ephemeral" }
}

override_resource {
  target = aws_cloudwatch_log_group.fn
  values = { arn = "arn:aws:logs:eu-west-1:123456789012:log-group:test" }
}

override_resource {
  target = aws_ssm_parameter.parameter
  values = { arn = "arn:aws:ssm:eu-west-1:123456789012:parameter/test" }
}

override_resource {
  target = aws_apigatewayv2_api.ws
  values = { execution_arn = "arn:aws:execute-api:eu-west-1:123456789012:test" }
}

override_resource {
  target = aws_apigatewayv2_stage.ws
  values = { name = "live" }
}

override_resource {
  target = aws_s3_bucket.media
  values = { arn = "arn:aws:s3:::test" }
}


run "last_use_index" {
  command = plan

  plan_options {
    target = [aws_dynamodb_table.table]
  }

  assert {
    condition = [for g in aws_dynamodb_table.table["directory"].global_secondary_index : {
      name = g.name, projection = g.projection_type, keys = [for k in g.key_schema : "${k.attribute_name} ${k.key_type}"]
      }] == [{
      name = "lastUse", projection = "KEYS_ONLY", keys = ["sk HASH", "lu RANGE"]
    }]
    error_message = "The directory must have one index, lastUse: sk and lu, keys only (backend/internal/directory, expiry.go)."
  }

  # Capped like its table: a flood of month changes can't cost more.
  assert {
    condition = alltrue([for g in aws_dynamodb_table.table["directory"].global_secondary_index : length(g.on_demand_throughput) == 1 && alltrue([
      for t in g.on_demand_throughput : t.max_write_request_units == 100 && t.max_read_request_units == 200
    ])])
    error_message = "The lastUse index must have its table's caps."
  }

  assert {
    condition     = length(aws_dynamodb_table.table["messages"].global_secondary_index) == 0 && length(aws_dynamodb_table.table["ephemeral"].global_secondary_index) == 0
    error_message = "Only the directory has an index."
  }
}

run "schedule_by_default" {
  command = plan

  plan_options {
    target = [aws_cloudwatch_event_rule.expire_accounts]
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_event_rule.expire_accounts.state == "ENABLED",
      aws_cloudwatch_event_rule.expire_accounts.schedule_expression == "rate(15 minutes)",
      startswith(aws_cloudwatch_event_rule.expire_accounts.name, "incognitochat-test-schedule-"),
    ])
    error_message = "Unset, the expiry runs (as a dry run) on an enabled schedule, named under the deploy role's prefix for rules."
  }
}

run "schedule_off" {
  command = plan

  variables {
    account_expiry = "off"
  }

  plan_options {
    target = [aws_cloudwatch_event_rule.expire_accounts]
  }

  assert {
    condition     = aws_cloudwatch_event_rule.expire_accounts.state == "DISABLED"
    error_message = "Off, the schedule is disabled."
  }
}

run "switch_takes_three_values" {
  command = plan

  variables {
    account_expiry = "yes"
  }

  plan_options {
    target = [aws_cloudwatch_event_rule.expire_accounts]
  }

  expect_failures = [var.account_expiry]
}

# api may query the directory's lastUse index, and no other index; no other
# function may. api is told the switch: dry-run unless set.
run "api_reads_only_the_last_use_index" {
  command = apply

  plan_options {
    target = [data.aws_iam_policy_document.fn]
  }

  assert {
    condition = [
      for s in jsondecode(data.aws_iam_policy_document.fn["api"].json).Statement : {
        actions = flatten([s.Action]), resources = flatten([s.Resource])
      } if anytrue([for r in flatten([s.Resource]) : strcontains(r, "/index/")])
      ] == [{
        actions   = ["dynamodb:Query"]
        resources = ["arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-directory/index/lastUse"]
    }]
    error_message = "api's role must reach the directory's lastUse index, to query it, and no other index."
  }

  assert {
    condition = alltrue(flatten([
      for f in ["bot", "ws", "notify"] : [
        for s in jsondecode(data.aws_iam_policy_document.fn[f].json).Statement :
        !anytrue([for r in flatten([s.Resource]) : strcontains(r, "/index/")])
      ]
    ]))
    error_message = "Only api reads the lastUse index."
  }

  assert {
    condition     = local.functions["api"].environment.ACCOUNT_EXPIRY == "dry-run"
    error_message = "Unset, api runs the expiry as a dry run."
  }
}

run "switch_in_api_environment" {
  command = apply

  variables {
    account_expiry = "on"
  }

  plan_options {
    target = [data.aws_iam_policy_document.fn["api"]]
  }

  assert {
    condition     = local.functions["api"].environment.ACCOUNT_EXPIRY == "on"
    error_message = "api must be told the switch."
  }
}
