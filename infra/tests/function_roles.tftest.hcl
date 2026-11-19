# Renders the notify function's role policy with the AWS provider's own
# policy document, and checks what it reaches: no table-wide DynamoDB
# action, and in the directory only account partitions, with the notice
# fields named (finding BOT-5; what IAM can't narrow further is in
# docs/security.md). Also that notify's timeout stays below the quiet
# period it holds while sending, and api's below the lease a deletion step
# holds on its account. Nothing touches AWS: the provider has
# fake credentials and makes no calls (a policy document is rendered
# locally), and every resource the policy refers to is overridden, so
# "apply" creates nothing. Run by CI (terraform test).

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
  # No previous keys, as the deploy passes them while their secrets are
  # unset. Given, since an ephemeral variable left to its default fails
  # terraform test's apply.
  previous_issuer_key       = ""
  previous_media_issuer_key = ""
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

run "notify_role" {
  # The policy document is read only once the resources it names exist,
  # which here means overridden in an apply.
  command = apply

  plan_options {
    target = [data.aws_iam_policy_document.fn["notify"]]
  }

  # Every statement granting DynamoDB actions limits the partition keys.
  assert {
    condition = alltrue([
      for s in jsondecode(data.aws_iam_policy_document.fn["notify"].json).Statement :
      length(flatten([try(s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"], [])])) > 0
      if anytrue([for a in flatten([s.Action]) : startswith(a, "dynamodb:")])
    ])
    error_message = "notify's role grants a DynamoDB action without limiting the partition keys (table-wide)."
  }

  # In the directory: GetItem and UpdateItem only.
  assert {
    condition = sort(distinct(flatten([
      for s in jsondecode(data.aws_iam_policy_document.fn["notify"].json).Statement : [
        for a in flatten([s.Action]) : a if startswith(a, "dynamodb:")
      ] if contains(flatten([s.Resource]), "arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-directory")
    ]))) == tolist(["dynamodb:GetItem", "dynamodb:UpdateItem"])
    error_message = "notify's role may call more than GetItem and UpdateItem on the directory."
  }

  # Each directory statement: account items only, with a partition key
  # (Null), the notice fields only; reads name their attributes, writes
  # touch only nm and no and return nothing.
  assert {
    condition = alltrue([
      for s in jsondecode(data.aws_iam_policy_document.fn["notify"].json).Statement : alltrue([
        try(alltrue([for k in flatten([s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]]) : k == "A#*"]), false),
        try(s.Condition["Null"]["dynamodb:LeadingKeys"] == "false", false),
        try(alltrue([for a in flatten([s.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"]]) : contains(["pk", "sk", "cid", "lg", "nm", "no"], a)]), false),
        !contains(flatten([s.Action]), "dynamodb:GetItem") || try(s.Condition["StringEquals"]["dynamodb:Select"] == "SPECIFIC_ATTRIBUTES", false),
        !contains(flatten([s.Action]), "dynamodb:UpdateItem") || try(
          s.Condition["StringEquals"]["dynamodb:ReturnValues"] == "NONE" &&
          alltrue([for a in flatten([s.Condition["ForAllValues:StringEquals"]["dynamodb:Attributes"]]) : contains(["pk", "sk", "nm", "no"], a)]),
          false
        ),
      ]) if contains(flatten([s.Resource]), "arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-directory")
    ])
    error_message = "A directory statement of notify's role reaches beyond the notice fields of account items."
  }

  # notify must stop before the quiet period it holds while sending a
  # notice runs out (notices.Lease, 30 s in backend/internal/notices), or a
  # second invocation could send another meanwhile.
  assert {
    condition     = local.functions["notify"].timeout < 30
    error_message = "notify's timeout must stay below notices.Lease (30 s)."
  }

  # api must stop before a deletion or cleanup step's lease on the account
  # runs out (leaseFor, 15 s in backend/internal/directory), or a second
  # step could start while one is still writing.
  assert {
    condition     = local.functions["api"].timeout < 15
    error_message = "api's timeout must stay below the deletion steps' lease (directory.leaseFor, 15 s)."
  }

  # No other table but its quiet periods' (the ephemeral table).
  assert {
    condition = sort(distinct(flatten([
      for s in jsondecode(data.aws_iam_policy_document.fn["notify"].json).Statement :
      flatten([s.Resource]) if anytrue([for a in flatten([s.Action]) : startswith(a, "dynamodb:")])
      ]))) == tolist([
      "arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-directory",
      "arn:aws:dynamodb:eu-west-1:123456789012:table/incognitochat-test-ephemeral",
    ])
    error_message = "notify's role reaches another table."
  }
}
