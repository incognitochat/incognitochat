# Renders the deploy role's policies with production's names (the longest)
# and checks that each fits in a managed policy, so that applying this stack
# can't stop halfway on one that doesn't, and that none of them allows a
# whole service again. Whether the denies hold in AWS is checked with IAM's
# policy simulator (scripts/check-function-roles.sh deploy-role) after each
# bootstrap and before each deploy. Then plans the alarms whose thresholds
# or presence depend on the environment. Nothing touches AWS: the provider
# has fake credentials and makes no calls (policy documents are rendered
# locally), every resource the policies refer to is overridden, so "apply"
# creates nothing, and so is the lookup of the media bucket. Run by CI
# (terraform test).

provider "aws" {
  region                      = "eu-west-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

provider "aws" {
  alias                       = "global"
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

variables {
  aws_region                 = "eu-west-1"
  state_bucket_name          = "incognitochat-tfstate-123456789012-eu-west-1"
  github_oidc_subject_prefix = "repo:example/example"
  github_environment         = "production"
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
  target = aws_s3_bucket.builds
  values = { arn = "arn:aws:s3:::incognitochat-production-builds-20251108161400000000000001" }
}

override_resource {
  target = aws_signer_signing_profile.lambda
  values = {
    arn         = "arn:aws:signer:eu-west-1:123456789012:/signing-profiles/incognitochat_production_lambda_20251108161400000000000001"
    version_arn = "arn:aws:signer:eu-west-1:123456789012:/signing-profiles/incognitochat_production_lambda_20251108161400000000000001/abcdefghij"
  }
}

override_resource {
  target = aws_lambda_code_signing_config.lambda
  values = { arn = "arn:aws:lambda:eu-west-1:123456789012:code-signing-config:csc-0123456789abcdef0" }
}

override_resource {
  target = aws_iam_policy.lambda_boundary
  values = { arn = "arn:aws:iam::123456789012:policy/incognitochat-production-lambda-boundary" }
}

override_resource {
  target = aws_iam_openid_connect_provider.github
  values = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
}

override_resource {
  target = aws_iam_role.deploy
  values = { arn = "arn:aws:iam::123456789012:role/incognitochat-production-github-deploy" }
}

# The app stack's media bucket, as the alarm on what it holds finds it.
override_data {
  target = data.aws_s3_buckets.media
  values = {
    buckets = [{
      name          = "incognitochat-production-media-0123456789ab"
      bucket_arn    = "arn:aws:s3:::incognitochat-production-media-0123456789ab"
      bucket_region = "eu-west-1"
      creation_date = "2025-11-08T16:14:00Z"
    }]
  }
}

run "deploy_policies" {
  # Policy documents are read only once the resources they name exist,
  # which here means overridden in an apply.
  command = apply

  plan_options {
    target = [
      data.aws_iam_policy_document.deploy,
      data.aws_iam_policy_document.deploy_functions,
      data.aws_iam_policy_document.deploy_edge,
      data.aws_iam_policy_document.deploy_no_items,
      data.aws_iam_policy_document.deploy_limits,
    ]
  }

  # IAM counts a managed policy's characters without whitespace.
  assert {
    condition = alltrue([
      for d in [
        data.aws_iam_policy_document.deploy,
        data.aws_iam_policy_document.deploy_functions,
        data.aws_iam_policy_document.deploy_edge,
        data.aws_iam_policy_document.deploy_no_items,
        data.aws_iam_policy_document.deploy_limits,
      ] : length(replace(d.json, "/\\s/", "")) <= 6144
    ])
    error_message = "A deploy policy is over IAM's 6,144 characters for a managed policy: move statements to another."
  }

  # Only the calls Terraform makes, not a whole service.
  assert {
    condition = alltrue([
      for d in [
        data.aws_iam_policy_document.deploy,
        data.aws_iam_policy_document.deploy_functions,
        data.aws_iam_policy_document.deploy_edge,
        ] : alltrue([
          for s in jsondecode(d.json).Statement : !anytrue([
            for a in flatten([try(s.Action, [])]) : endswith(a, ":*") || a == "*"
          ]) if s.Effect == "Allow"
      ])
    ])
    error_message = "A deploy policy allows every action of a service."
  }
}

# The alarms whose thresholds or presence depend on the environment: the
# tables' caps (the app stack's defaults), the media bucket found, and the
# firewall in production only. A plan: nothing is created.
run "alarms_in_production" {
  command = plan

  plan_options {
    target = [
      aws_cloudwatch_metric_alarm.table_capacity,
      aws_cloudwatch_metric_alarm.media_stored,
      aws_cloudwatch_metric_alarm.firewall_blocks,
    ]
  }

  # 70% of 400 reads and 200 writes a second, over 5 minutes.
  assert {
    condition = (
      contains([for q in aws_cloudwatch_metric_alarm.table_capacity["directory"].metric_query : q.expression], "100 * reads / 120000")
      && contains([for q in aws_cloudwatch_metric_alarm.table_capacity["directory"].metric_query : q.expression], "100 * writes / 60000")
      && aws_cloudwatch_metric_alarm.table_capacity["directory"].threshold == 70
    )
    error_message = "The table-capacity alarms don't follow production's caps."
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.media_stored) == 1
      && anytrue([for q in aws_cloudwatch_metric_alarm.media_stored[0].metric_query : length(q.metric) > 0 && q.metric[0].dimensions.BucketName == "incognitochat-production-media-0123456789ab"])
    )
    error_message = "The media-stored alarm doesn't watch the bucket found."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.firewall_blocks) == 1 && aws_cloudwatch_metric_alarm.firewall_blocks[0].dimensions.WebACL == "incognitochat-production-api"
    error_message = "Production has no alarm on the firewall's blocks, or it reads another web ACL."
  }
}

run "alarms_elsewhere" {
  command = plan

  variables {
    github_environment    = "dev"
    table_max_write_units = 50
  }

  plan_options {
    target = [
      aws_cloudwatch_metric_alarm.table_capacity,
      aws_cloudwatch_metric_alarm.firewall_blocks,
    ]
  }

  # 70% of the default 200 reads, and of the 50 writes set.
  assert {
    condition = (
      contains([for q in aws_cloudwatch_metric_alarm.table_capacity["messages"].metric_query : q.expression], "100 * reads / 60000")
      && contains([for q in aws_cloudwatch_metric_alarm.table_capacity["messages"].metric_query : q.expression], "100 * writes / 15000")
    )
    error_message = "The table-capacity alarms don't follow the caps elsewhere."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.firewall_blocks) == 0
    error_message = "An environment without a firewall has an alarm on its blocks."
  }
}
