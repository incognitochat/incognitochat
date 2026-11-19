# Renders the deploy role's policies with production's names (the longest)
# and checks that each fits in a managed policy, so that applying this stack
# can't stop halfway on one that doesn't, and that none of them allows a
# whole service again. Whether the denies hold in AWS is checked with IAM's
# policy simulator (scripts/check-function-roles.sh deploy-role) after each
# bootstrap and before each deploy. Then checks the audit trail's bucket
# policy, plans the trail and the change alerts (management events only;
# which callers they leave out), and plans the alarms whose thresholds or
# presence depend on the environment. Nothing touches AWS: the provider
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
  target = aws_s3_bucket.audit
  values = { arn = "arn:aws:s3:::incognitochat-production-audit-20251108161400000000000001" }
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

  # The audit trail and its bucket stay out of the deploy role's reach.
  assert {
    condition = anytrue([
      for s in jsondecode(data.aws_iam_policy_document.deploy_limits.json).Statement :
      s.Effect == "Deny" && flatten([s.Action]) == ["cloudtrail:*"] && flatten([try(s.Resource, [])]) == ["*"]
    ])
    error_message = "The deploy role isn't denied every CloudTrail call."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(data.aws_iam_policy_document.deploy_limits.json).Statement :
      s.Effect == "Deny" && flatten([s.Action]) == ["s3:*"] && toset(flatten([try(s.Resource, [])])) == toset([
        "arn:aws:s3:::incognitochat-production-audit-*",
        "arn:aws:s3:::incognitochat-production-audit-*/*",
      ])
    ])
    error_message = "The deploy role isn't denied every call on the audit trail's bucket."
  }
}

# The audit trail's bucket policy: CloudTrail alone writes, this trail
# alone, under this account's AWSLogs/, and nobody deletes a record.
run "audit_bucket_policy" {
  command = apply

  plan_options {
    target = [data.aws_iam_policy_document.audit_bucket]
  }

  assert {
    condition = alltrue([
      for s in jsondecode(data.aws_iam_policy_document.audit_bucket.json).Statement :
      s.Principal == { Service = "cloudtrail.amazonaws.com" }
      && s.Condition.StringEquals["aws:SourceArn"] == "arn:aws:cloudtrail:eu-west-1:123456789012:trail/incognitochat-production-audit"
      if s.Effect == "Allow"
    ])
    error_message = "The audit bucket's policy lets someone other than this trail in."
  }

  assert {
    condition = toset(flatten([
      for s in jsondecode(data.aws_iam_policy_document.audit_bucket.json).Statement : flatten([s.Resource])
      if s.Effect == "Allow" && contains(flatten([s.Action]), "s3:PutObject")
    ])) == toset(["arn:aws:s3:::incognitochat-production-audit-20251108161400000000000001/AWSLogs/123456789012/*"])
    error_message = "CloudTrail may write elsewhere than this account's AWSLogs/ in the audit bucket."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(data.aws_iam_policy_document.audit_bucket.json).Statement :
      s.Effect == "Deny" && s.Principal == "*" && try(s.Condition, null) == null
      && toset(flatten([s.Action])) == toset(["s3:DeleteObject", "s3:DeleteObjectVersion"])
    ])
    error_message = "The audit bucket's policy doesn't deny deleting records to everyone."
  }
}

# The trail records every region's management events and nothing else (no
# data events: nothing about users), signs its files, and keeps them 365
# days by default. The change alerts leave out the deploy role's calls
# only where deploys make changes as their job.
run "audit_trail_and_alerts" {
  command = plan

  plan_options {
    target = [
      aws_cloudtrail.audit,
      aws_s3_bucket_lifecycle_configuration.audit,
      aws_cloudwatch_event_rule.changes,
      aws_cloudwatch_event_rule.audit_changes,
      aws_cloudwatch_event_rule.iam_changes,
      aws_cloudwatch_event_rule.edge_changes,
      aws_cloudwatch_event_rule.access_findings,
    ]
  }

  assert {
    condition = (
      aws_cloudtrail.audit.is_multi_region_trail
      && aws_cloudtrail.audit.include_global_service_events
      && aws_cloudtrail.audit.enable_log_file_validation
      && aws_cloudtrail.audit.enable_logging
      && !aws_cloudtrail.audit.is_organization_trail
    )
    error_message = "The trail doesn't cover every region and global service, or doesn't sign its files."
  }

  assert {
    condition = (
      length(aws_cloudtrail.audit.event_selector) == 0
      && length(aws_cloudtrail.audit.insight_selector) == 0
      && length(aws_cloudtrail.audit.advanced_event_selector) == 1
      && length(aws_cloudtrail.audit.advanced_event_selector[0].field_selector) == 1
      && alltrue([
        for f in aws_cloudtrail.audit.advanced_event_selector[0].field_selector :
        f.field == "eventCategory" && toset(f.equals) == toset(["Management"])
      ])
    )
    error_message = "The trail records more than management events (data events would record users' activity)."
  }

  assert {
    condition = (
      one(aws_s3_bucket_lifecycle_configuration.audit.rule).expiration[0].days == 365
      && one(aws_s3_bucket_lifecycle_configuration.audit.rule).noncurrent_version_expiration[0].noncurrent_days == 30
    )
    error_message = "The audit trail's files aren't kept 365 days by default (docs/data.md)."
  }

  # Excluded where deploys make changes; included for IAM, CloudTrail and
  # the alerts' own rules and topics.
  assert {
    condition = alltrue([
      for r in [aws_cloudwatch_event_rule.changes, aws_cloudwatch_event_rule.edge_changes] :
      jsondecode(r.event_pattern).detail.userIdentity["$or"] == [
        { arn = [{ "anything-but" = { prefix = "arn:aws:sts::123456789012:assumed-role/incognitochat-production-github-deploy/" } }] },
        { arn = [{ exists = false }] },
      ]
    ])
    error_message = "A change alert on what deploys change doesn't leave out exactly the deploy role's calls."
  }

  assert {
    condition = alltrue([
      for r in [aws_cloudwatch_event_rule.iam_changes, aws_cloudwatch_event_rule.audit_changes] :
      !can(jsondecode(r.event_pattern).detail.userIdentity)
    ])
    error_message = "The IAM or audit change alerts leave out some callers."
  }

  assert {
    condition = (
      contains(jsondecode(aws_cloudwatch_event_rule.iam_changes.event_pattern).detail.eventSource, "iam.amazonaws.com")
      && contains(jsondecode(aws_cloudwatch_event_rule.audit_changes.event_pattern).detail.eventSource, "cloudtrail.amazonaws.com")
      && !contains([for p in jsondecode(aws_cloudwatch_event_rule.iam_changes.event_pattern).detail.eventName : p.prefix], "Simulate")
    )
    error_message = "The change alerts miss IAM or CloudTrail changes, or match the deploy's policy simulations."
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
