# The edge in front of the API (edge.tf). CloudFront passes on to the
# function only what the API reads (finding TF-12): no cookies, none of the
# headers CloudFront can add on where a viewer is. Where the firewall is
# on, its first rule blocks the addresses in an IP set an admin fills during
# an incident (OPS-8), its second refuses every IPv6 address, and the rate
# limits keep their order after them. Without the firewall, none of it
# exists. And the functions' logs are kept only for a period CloudWatch
# takes, never forever (TF-13). Plans only: the providers have fake
# credentials and make no calls (the IPv6 run overrides the IP sets' ARNs).
# Run by CI (terraform test).

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
    target = [aws_wafv2_web_acl.api, aws_wafv2_ip_set.blocked, aws_wafv2_ip_set.ipv6]
  }

  assert {
    condition     = length(aws_wafv2_web_acl.api) == 0 && length(aws_wafv2_ip_set.blocked) == 0 && length(aws_wafv2_ip_set.ipv6) == 0
    error_message = "Without the firewall there must be no web ACL, no block list and no IPv6 set."
  }
}

run "firewall" {
  command = plan

  plan_options {
    target = [aws_wafv2_web_acl.api, aws_wafv2_ip_set.blocked]
  }

  variables {
    firewall = true
    # Caps that differ in each direction from the environment's own, so
    # deletes-total must take the lower.
    table_max_read_units  = 1000
    table_max_write_units = 200
  }

  # Empty (the plan has an empty set as null), IPv4 (the firewall refuses
  # IPv6 outright), for CloudFront.
  assert {
    condition = length(aws_wafv2_ip_set.blocked) == 1 && alltrue([
      aws_wafv2_ip_set.blocked[0].name == "incognitochat-test-blocked",
      aws_wafv2_ip_set.blocked[0].scope == "CLOUDFRONT",
      aws_wafv2_ip_set.blocked[0].ip_address_version == "IPV4",
      try(length(aws_wafv2_ip_set.blocked[0].addresses), 0) == 0,
    ])
    error_message = "With the firewall there must be one empty IPv4 block list for CloudFront, named with the prefix."
  }

  # The block list first, then IPv6, then the rate limits in their order.
  assert {
    condition = jsonencode({ for r in aws_wafv2_web_acl.api[0].rule : tostring(r.priority) => r.name }) == jsonencode({
      "0" = "blocked"
      "1" = "ipv6"
      "2" = "rate-per-ip"
      "3" = "anonymous-per-ip"
      "4" = "lookups-total"
      "5" = "deletes-total"
    })
    error_message = "The firewall's rules must be the block list (priority 0), ipv6 (1), then rate-per-ip, anonymous-per-ip, lookups-total and deletes-total."
  }

  # Batches of uploads to delete have their own total, sized by the lower
  # of the read and write caps (here 1,000 and 200: 120 a minute), over
  # POST /media/delete alone.
  assert {
    condition = length([
      for r in aws_wafv2_web_acl.api[0].rule : r.name
      if r.name == "deletes-total" && alltrue([
        r.statement[0].rate_based_statement[0].limit == 120,
        r.statement[0].rate_based_statement[0].aggregate_key_type == "CONSTANT",
        r.statement[0].rate_based_statement[0].evaluation_window_sec == 60,
        r.statement[0].rate_based_statement[0].scope_down_statement[0].and_statement[0].statement[1].regex_match_statement[0].regex_string == local.delete_routes.POST,
      ])
    ]) == 1
    error_message = "deletes-total must count everyone's POST /media/delete together, over a minute, at 0.6 times the lower of the read and write caps."
  }

  # WAF refuses an OR of fewer than two statements (production's apply of
  # 2.6.0 failed on one): a rule's routes are an OR only when there are two
  # or more, else the one route's AND.
  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.api[0].rule : alltrue([
        for d in r.statement[0].rate_based_statement[0].scope_down_statement :
        (length(d.or_statement) == 0 || length(d.or_statement[0].statement) >= 2) &&
        (length(d.or_statement) + length(d.and_statement) == 1)
      ])
      if length(r.statement[0].rate_based_statement) > 0
    ])
    error_message = "Each rate limit's routes must be one AND, or an OR of two or more: WAF refuses an OR of one statement."
  }

  # The batch route counts towards deletes-total and anonymous-per-ip, not
  # lookups-total; the single delete counts towards lookups-total alone.
  assert {
    condition = alltrue([
      can(regex(local.delete_routes.POST, "/media/delete")),
      can(regex(local.delete_routes.POST, "/../media/delete")),
      can(regex(local.anonymous_routes.POST, "/media/delete")),
      !can(regex(local.lookup_routes.POST, "/media/delete")),
      !can(regex(local.delete_routes.POST, "/media/AAAAAAAAAAAAAAAAAAAAAA/delete")),
      !can(regex(local.anonymous_routes.POST, "/media/AAAAAAAAAAAAAAAAAAAAAA/delete")),
      can(regex(local.lookup_routes.POST, "/media/AAAAAAAAAAAAAAAAAAAAAA/delete")),
    ])
    error_message = "POST /media/delete must count towards deletes-total and anonymous-per-ip, not lookups-total; POST /media/{id}/delete towards lookups-total alone."
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

  # No sampled requests, from any rule or the web ACL itself: they would
  # hold client addresses and headers, which the firewall never keeps.
  assert {
    condition = alltrue(concat(
      [for r in aws_wafv2_web_acl.api[0].rule : !r.visibility_config[0].sampled_requests_enabled],
      [!aws_wafv2_web_acl.api[0].visibility_config[0].sampled_requests_enabled],
    ))
    error_message = "No firewall rule, nor the web ACL, may keep sampled requests (they would hold addresses)."
  }

  # AWS WAF checks descriptions against this pattern only when applying
  # (CreateIPSet and CreateWebACL, Description: 1 to 256 characters; no
  # parentheses or apostrophes, say), while the provider checks only the
  # length: a plan passes that the apply refuses.
  assert {
    condition = alltrue([
      for d in [
        aws_wafv2_ip_set.blocked[0].description,
        aws_wafv2_ip_set.ipv6[0].description,
        aws_wafv2_web_acl.api[0].description,
      ] :
      length(d) <= 256 && can(regex("^[\\w+=:#@/\\-,\\.][\\w+=:#@/\\-,\\.\\s]+[\\w+=:#@/\\-,\\.]$", d))
    ])
    error_message = "The IP sets' and the web ACL's descriptions must match AWS WAF's pattern for descriptions (letters, digits, spaces and _+=:#@/-,. only)."
  }

  # The block list and ipv6 are the only rules that use IP sets.
  assert {
    condition = sort([
      for r in aws_wafv2_web_acl.api[0].rule : r.name
      if length(r.statement[0].ip_set_reference_statement) > 0
    ]) == tolist(["blocked", "ipv6"])
    error_message = "Only the block list's rule and ipv6 may use IP sets."
  }
}

# Where the firewall is on, it refuses IPv6 outright, before any rate limit
# counts it: an edge serves the API over IPv6 to a client that connects to
# its IPv6 address, though the distribution has IPv6 off (found by testing,
# 2026-11-22), and one host has billions of IPv6 addresses. The IP sets'
# ARNs are known in a plan only when overridden.
run "firewall_ipv6" {
  command = plan

  plan_options {
    target = [aws_wafv2_web_acl.api, aws_wafv2_ip_set.blocked, aws_wafv2_ip_set.ipv6]
  }

  variables {
    firewall = true
  }

  override_resource {
    target          = aws_wafv2_ip_set.blocked
    override_during = plan
    values          = { arn = "arn:aws:wafv2:us-east-1:123456789012:global/ipset/incognitochat-test-blocked/blocked" }
  }

  override_resource {
    target          = aws_wafv2_ip_set.ipv6
    override_during = plan
    values          = { arn = "arn:aws:wafv2:us-east-1:123456789012:global/ipset/incognitochat-test-ipv6/ipv6" }
  }

  # Every IPv6 address: WAF takes any range but /0, hence two halves.
  assert {
    condition = length(aws_wafv2_ip_set.ipv6) == 1 && alltrue([
      aws_wafv2_ip_set.ipv6[0].name == "incognitochat-test-ipv6",
      aws_wafv2_ip_set.ipv6[0].scope == "CLOUDFRONT",
      aws_wafv2_ip_set.ipv6[0].ip_address_version == "IPV6",
      aws_wafv2_ip_set.ipv6[0].addresses == toset(["::/1", "8000::/1"]),
    ])
    error_message = "With the firewall there must be one IPv6 set for CloudFront, named with the prefix, holding exactly ::/1 and 8000::/1."
  }

  # ipv6 matches the request's own address (not a forwarded header) against
  # that set, and blocked against the block list, each with its own metric.
  assert {
    condition = length([
      for r in aws_wafv2_web_acl.api[0].rule : r.name
      if r.name == "ipv6" && alltrue([
        try(r.statement[0].ip_set_reference_statement[0].arn, "") == aws_wafv2_ip_set.ipv6[0].arn,
        try(length(r.statement[0].ip_set_reference_statement[0].ip_set_forwarded_ip_config), 1) == 0,
        r.visibility_config[0].metric_name == "incognitochat-test-api-ipv6",
      ])
    ]) == 1
    error_message = "The ipv6 rule must match each request's own address against the IPv6 set, with the metric incognitochat-test-api-ipv6."
  }

  assert {
    condition = length([
      for r in aws_wafv2_web_acl.api[0].rule : r.name
      if r.name == "blocked" && try(r.statement[0].ip_set_reference_statement[0].arn, "") == aws_wafv2_ip_set.blocked[0].arn
    ]) == 1
    error_message = "The blocked rule must use the block list."
  }

  # Answered as a blocked address is: 429 with the API's error and CORS.
  assert {
    condition = length([
      for r in aws_wafv2_web_acl.api[0].rule : r.name
      if r.name == "ipv6" && alltrue([
        jsonencode(r.action) == jsonencode(one([for b in aws_wafv2_web_acl.api[0].rule : b.action if b.name == "blocked"])),
        try(r.action[0].block[0].custom_response[0].response_code, 0) == 429,
        try(r.action[0].block[0].custom_response[0].custom_response_body_key, "") == local.blocked_body,
      ])
    ]) == 1
    error_message = "The ipv6 rule must block with the block list's response: 429 and the API's rate_limited error."
  }

  # Before every rate limit, so none of them counts an IPv6 request.
  assert {
    condition = (
      length([for r in aws_wafv2_web_acl.api[0].rule : r.name if length(r.statement[0].rate_based_statement) > 0]) == 4
      && alltrue([
        for r in aws_wafv2_web_acl.api[0].rule :
        one([for v in aws_wafv2_web_acl.api[0].rule : v.priority if v.name == "ipv6"]) < r.priority
        if length(r.statement[0].rate_based_statement) > 0
      ])
    )
    error_message = "The ipv6 rule must run before every rate-based rule (a lower priority number)."
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
