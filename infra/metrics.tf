# Metrics from the api function's request counts (backend/internal/tally):
# each instance logs one line a minute while it answers requests, with
# counts only, by route and status ("routes") and by error code ("errors"),
# and for the public statistics, the messages sent ("messages") and the
# padded bytes of uploads paid for ("media_bytes").
# Metric filters are free. Each metric is billed as a custom metric, $0.30
# a month, but only for the hours it gets data: no default value is set,
# so a metric with nothing to count costs nothing. The alarms on these
# metrics are in the bootstrap stack (infra/init/alerts.tf), which CI can't
# change; its namespace must stay the same as this one.
locals {
  counts_namespace = "${local.prefix}/api"

  # Filter => the metric it adds to, and the count it adds, as a path in
  # the line. Four filters add to Limited, one for each code a 429 answer
  # has.
  count_metrics = {
    registrations      = { metric = "Registrations", count = "routes.post_register_200" }
    send-tokens        = { metric = "SendTokenRequests", count = "routes.post_tokens_200" }
    media-tokens       = { metric = "MediaTokenRequests", count = "routes.post_tokens_media_200" }
    rate-limited       = { metric = "Limited", count = "errors.rate_limited" }
    daily-limit        = { metric = "Limited", count = "errors.daily_limit" }
    link-busy          = { metric = "Limited", count = "errors.link_busy" }
    download-limit     = { metric = "Limited", count = "errors.download_limit" }
    invalid-token      = { metric = "InvalidToken", count = "errors.invalid_token" }
    init-data-rejected = { metric = "InitDataRejected", count = "errors.init_data_rejected" }
    signature-rejected = { metric = "SignatureRejected", count = "errors.signature_rejected" }
    # For the public statistics: messages sent (sends that aren't quiet),
    # and the padded size of the uploads paid for, in bytes.
    messages    = { metric = "Messages", count = "messages" }
    media-bytes = { metric = "MediaBytes", count = "media_bytes" }
  }

  # The routes that answer 429 (rate_limited, daily_limit, link_busy or
  # download_limit), as the line names them: each gets Limited.<route>, to
  # tell which limit is being hit. A route missing here still counts in
  # Limited, and shows in the line.
  limited_routes = [
    "post_register",
    "post_accounts_lookup",
    "post_invitations_redeem",
    "post_links",
    "post_mailboxes",
    "post_mailboxes_check",
    "post_notices",
    "post_send",
    "post_tokens",
    "post_tokens_media",
    "get_inbox",
    "get_media_id",
  ]
}

resource "aws_cloudwatch_log_metric_filter" "counts" {
  for_each = merge(local.count_metrics, {
    for route in local.limited_routes :
    "limited-${route}" => { metric = "Limited.${route}", count = "routes.${route}_429" }
  })

  name           = "${local.prefix}-api-${each.key}"
  log_group_name = aws_cloudwatch_log_group.fn["api"].name
  pattern        = "{ $.${each.value.count} > 0 }"

  metric_transformation {
    namespace = local.counts_namespace
    name      = each.value.metric
    value     = "$.${each.value.count}"
    unit      = each.value.metric == "MediaBytes" ? "Bytes" : "Count"
  }
}

# The account expiry's error lines (backend/internal/api, expiry.go): a run
# that failed, paused (no account recorded a recent month of use, so it
# deleted nothing) or passed over stuck accounts; and logins that couldn't
# record their month (session.go), which a year on would make accounts in
# use look unused. Each line counts one, for the account-expiry alarm in
# infra/init/alerts.tf. The lines are constant: backend/internal/api's
# tests check these still match them.
resource "aws_cloudwatch_log_metric_filter" "expiry" {
  for_each = {
    expiry-problems  = { metric = "ExpiryProblems", pattern = "{ ($.route = \"account expiry\") && ($.level = \"ERROR\") }" }
    use-not-recorded = { metric = "UseNotRecorded", pattern = "{ ($.msg = \"month of use not recorded\") && ($.level = \"ERROR\") }" }
  }

  name           = "${local.prefix}-api-${each.key}"
  log_group_name = aws_cloudwatch_log_group.fn["api"].name
  pattern        = each.value.pattern

  metric_transformation {
    namespace = local.counts_namespace
    name      = each.value.metric
    value     = "1"
    unit      = "Count"
  }
}
