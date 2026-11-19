# The edge in front of the API (edge.tf). CloudFront passes on to the
# function only what the API reads (finding TF-12): no cookies, none of the
# headers CloudFront can add on where a viewer is. Where the firewall is
# on, its first rule blocks the addresses in an IP set an admin fills during
# an incident, and the rate limits keep their order after it (OPS-8).
# Without the firewall, neither exists. And the functions' logs are kept
# only for a period CloudWatch takes, never forever (TF-13). Plans only:
# the providers have fake credentials and make no calls. Run by CI
# (terraform test).

provider "aws" {
  region                      = "eu-west-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

# CloudFront's firewalls live in us-east-1 (edge.tf).
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

run "origin_request_policy" {
  command = plan

  plan_options {
    target = [aws_cloudfront_origin_request_policy.api]
  }

  # Exactly these: CORS, the JSON body's type, the session and the device
  # signature. authorization and x-amz-content-sha256 can't be listed
  # (CloudFront refuses both in a policy, and signs with the body's hash
  # by itself), and the CloudFront-Viewer-* headers must not be.
  assert {
    condition = sort(tolist(aws_cloudfront_origin_request_policy.api.headers_config[0].headers[0].items)) == sort([
      "access-control-request-headers",
      "access-control-request-method",
      "content-type",
      "origin",
      "x-device-signature",
      "x-session",
    ])
    error_message = "CloudFront must pass on to the API exactly the headers it reads, and the CORS request headers."
  }

  assert {
    condition     = aws_cloudfront_origin_request_policy.api.headers_config[0].header_behavior == "whitelist"
    error_message = "The origin request policy must list the headers it passes on, not pass on every viewer header."
  }

  assert {
    condition     = aws_cloudfront_origin_request_policy.api.cookies_config[0].cookie_behavior == "none"
    error_message = "CloudFront must pass on no cookies to the API."
  }

  # GET /inbox?after=...
  assert {
    condition     = aws_cloudfront_origin_request_policy.api.query_strings_config[0].query_string_behavior == "all"
    error_message = "CloudFront must pass on the query string (GET /inbox reads after)."
  }

  assert {
    condition     = aws_cloudfront_origin_request_policy.api.name == "incognitochat-test-api"
    error_message = "The origin request policy must be named with the stack's prefix."
  }
}

run "no_firewall" {
  command = plan

  plan_options {
    target = [aws_wafv2_web_acl.api, aws_wafv2_ip_set.blocked]
  }

  assert {
    condition     = length(aws_wafv2_web_acl.api) == 0 && length(aws_wafv2_ip_set.blocked) == 0
    error_message = "Without the firewall there must be no web ACL and no block list."
  }
}

run "firewall" {
  command = plan

  plan_options {
    target = [aws_wafv2_web_acl.api, aws_wafv2_ip_set.blocked]
  }

  variables {
    firewall = true
  }

  # Empty (the plan has an empty set as null), IPv4 (the API answers over
  # IPv4 alone), for CloudFront.
  assert {
    condition = length(aws_wafv2_ip_set.blocked) == 1 && alltrue([
      aws_wafv2_ip_set.blocked[0].name == "incognitochat-test-blocked",
      aws_wafv2_ip_set.blocked[0].scope == "CLOUDFRONT",
      aws_wafv2_ip_set.blocked[0].ip_address_version == "IPV4",
      try(length(aws_wafv2_ip_set.blocked[0].addresses), 0) == 0,
    ])
    error_message = "With the firewall there must be one empty IPv4 block list for CloudFront, named with the prefix."
  }

  # The block list first, then the rate limits in their order.
  assert {
    condition = jsonencode({ for r in aws_wafv2_web_acl.api[0].rule : tostring(r.priority) => r.name }) == jsonencode({
      "0" = "blocked"
      "1" = "rate-per-ip"
      "2" = "anonymous-per-ip"
      "3" = "lookups-total"
    })
    error_message = "The firewall's rules must be the block list (priority 0), then rate-per-ip, anonymous-per-ip and lookups-total."
  }

  # Priority 0 blocks what the IP set holds.
  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.api[0].rule :
      length(r.statement[0].ip_set_reference_statement) == 1 && length(r.action[0].block) == 1
      if r.priority == 0
    ])
    error_message = "The firewall's first rule must block the addresses in the block list."
  }

  # The block list is the only rule that uses an IP set.
  assert {
    condition = length([
      for r in aws_wafv2_web_acl.api[0].rule : r.name
      if length(r.statement[0].ip_set_reference_statement) > 0
    ]) == 1
    error_message = "Only the block list's rule may use an IP set."
  }
}

run "log_retention" {
  command = plan

  plan_options {
    target = [aws_cloudwatch_log_group.fn]
  }

  variables {
    log_retention_days = 14
  }

  assert {
    condition     = alltrue([for g in aws_cloudwatch_log_group.fn : g.retention_in_days == 14])
    error_message = "log_retention_days must set every function's log retention."
  }
}

run "log_retention_not_cloudwatchs" {
  command = plan

  plan_options {
    target = [aws_cloudwatch_log_group.fn]
  }

  variables {
    log_retention_days = 8
  }

  expect_failures = [var.log_retention_days]
}

run "log_retention_not_forever" {
  command = plan

  plan_options {
    target = [aws_cloudwatch_log_group.fn]
  }

  variables {
    log_retention_days = 0
  }

  expect_failures = [var.log_retention_days]
}
