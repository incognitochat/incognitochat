# Cost and health alerts for the account: a monthly budget and a few
# CloudWatch alarms, all publishing to one SNS topic, except those on
# CloudFront and its firewall, whose metrics are in us-east-1: they publish
# to a second topic there (at the end), as do AWS's cost anomaly alerts.
# They live in this stack so that CI, which can't change it, can't silence
# them either. The six on the api function's request counts are the
# exception: CI deploys what they read (the log line, the metric filters,
# the log level), so it could.
#
# The change alerts and Access Analyzer's findings (audit.tf) publish to
# the same topics: those of the app's region to the first, those of
# us-east-1 (IAM, CloudFront, the firewall) to the second.
#
# The topics start without subscribers: whoever runs the deployment
# subscribes an address to each themselves (docs/deployment.md), so no
# address is ever written to the repository or to Terraform state.

resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "BudgetsAndAlarmsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  # The change alerts and Access Analyzer's findings (audit.tf).
  statement {
    sid       = "ChangeAlertsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = [
        aws_cloudwatch_event_rule.changes.arn,
        aws_cloudwatch_event_rule.audit_changes.arn,
        aws_cloudwatch_event_rule.access_findings.arn,
      ]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

# Alerts at half the budget, at the whole of it, and when the month is
# forecast to pass it. Billing data lags by hours, so the alarms below are
# what notices a flood first.
resource "aws_budgets_budget" "monthly" {
  name         = "${local.prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(local.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = {
      half     = { type = "ACTUAL", threshold = 50 }
      whole    = { type = "ACTUAL", threshold = 100 }
      forecast = { type = "FORECASTED", threshold = 100 }
    }
    content {
      comparison_operator       = "GREATER_THAN"
      notification_type         = notification.value.type
      threshold                 = notification.value.threshold
      threshold_type            = "PERCENTAGE"
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
    }
  }

  depends_on = [aws_sns_topic_policy.alerts]
}

locals {
  alarm_period = 300
}

# Any function refused for lack of concurrency: the account's quota or a
# function's reservation is used up, by load or by a flood.
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${local.prefix}-lambda-throttles"
  alarm_description   = "Function invocations were refused for lack of concurrency."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Far more API requests than real use makes: a flood, which costs money and
# crowds real users out.
resource "aws_cloudwatch_metric_alarm" "api_invocations" {
  alarm_name          = "${local.prefix}-api-invocations"
  alarm_description   = "The api function is being called more than ${var.api_invocations_alarm} times in 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = "${local.prefix}-api" }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.api_invocations_alarm
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The api function failing (crashes and timeouts; handled errors are answers,
# not failures).
resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${local.prefix}-api-errors"
  alarm_description   = "The api function failed more than 10 times in 5 minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = "${local.prefix}-api" }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The other functions failing at all: crashes and timeouts, and errors
# they return to Lambda (notify's: a notice it couldn't send, unless
# Telegram's flood control or a blocked bot refused it; ws logs a failed
# push instead). api invokes ws, and ws notify, without waiting, and Lambda
# never tries those events again (../functions.tf): each failure is a lost
# push or notice, and so is an event dropped after waiting a minute for
# room to run (AsyncEventsDropped, which counts failed events too). A bot
# update that failed, Telegram sends again.
resource "aws_cloudwatch_metric_alarm" "function_errors" {
  for_each = {
    bot    = { errors = "Errors" }
    notify = { errors = "Errors", dropped = "AsyncEventsDropped" }
    ws     = { errors = "Errors", dropped = "AsyncEventsDropped" }
  }

  alarm_name          = "${local.prefix}-${each.key}-errors"
  alarm_description   = "The ${each.key} function failed${length(each.value) > 1 ? " or dropped an event" : ""} in the last 5 minutes."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "failures"
    expression  = "SUM(METRICS())"
    label       = "Failed or dropped"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = each.value
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/Lambda"
        metric_name = metric_query.value
        dimensions  = { FunctionName = "${local.prefix}-${each.key}" }
        stat        = "Sum"
        period      = local.alarm_period
      }
    }
  }
}

# The WebSocket API refusing requests. ClientError counts those API Gateway
# refused before ws ran: mostly its throttle (WS_THROTTLE_RATE_LIMIT,
# WS_THROTTLE_BURST_LIMIT), which everyone shares, so a flood of connects
# keeps real apps from connecting and pushes stop. IntegrationError counts
# those ws refused or failed: a session that doesn't check out (forged or
# ended), more connects than one account may make, or ws's own failure.
# The API's ID is random (../websocket.tf), so the queries take every
# WebSocket API in the account: the app stack makes one.
resource "aws_cloudwatch_metric_alarm" "ws_api" {
  for_each = { client-errors = "ClientError", integration-errors = "IntegrationError" }

  alarm_name          = "${local.prefix}-ws-${each.key}"
  alarm_description   = "More than ${var.ws_errors_alarm} WebSocket requests were counted as ${each.value} in 5 minutes."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.ws_errors_alarm
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "errors"
    expression  = "SELECT SUM(${each.value}) FROM SCHEMA(\"AWS/ApiGateway\", ApiId)"
    label       = each.value
    period      = local.alarm_period
    return_data = true
  }
}

# A table refusing requests: its per-second cap (a cost guard in the app
# stack) is reached, so real users are being turned away.
resource "aws_cloudwatch_metric_alarm" "table_throttles" {
  for_each = toset(["directory", "messages", "ephemeral"])

  alarm_name          = "${local.prefix}-${each.key}-table-throttles"
  alarm_description   = "The ${each.key} table refused requests: its read or write cap is reached."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "throttled"
    expression  = "FILL(reads, 0) + FILL(writes, 0)"
    label       = "Throttled requests"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { reads = "ReadThrottleEvents", writes = "WriteThrottleEvents" }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/DynamoDB"
        metric_name = metric_query.value
        dimensions  = { TableName = "${local.prefix}-${each.key}" }
        stat        = "Sum"
        period      = local.alarm_period
      }
    }
  }
}

# A table nearing its cap, before the cap refuses anyone: the share of its
# read or write cap (whichever is higher) it used on average over 5
# minutes. The caps are the app stack's (variables.tf).
locals {
  table_caps = {
    reads  = coalesce(var.table_max_read_units, var.github_environment == "production" ? 400 : 200)
    writes = coalesce(var.table_max_write_units, var.github_environment == "production" ? 200 : 100)
  }
}

resource "aws_cloudwatch_metric_alarm" "table_capacity" {
  for_each = toset(["directory", "messages", "ephemeral"])

  alarm_name          = "${local.prefix}-${each.key}-table-capacity"
  alarm_description   = "The ${each.key} table used more than ${var.table_capacity_alarm_percent}% of its read cap (${local.table_caps.reads} units a second) or of its write cap (${local.table_caps.writes}) over 5 minutes."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.table_capacity_alarm_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "used"
    expression  = "MAX([reads_share, writes_share])"
    label       = "Share of the cap used (%)"
    return_data = true
  }

  # The units used in 5 minutes, as a share of what the cap allows in them.
  dynamic "metric_query" {
    for_each = local.table_caps
    content {
      id         = "${metric_query.key}_share"
      expression = "100 * ${metric_query.key} / ${metric_query.value * local.alarm_period}"
    }
  }

  dynamic "metric_query" {
    for_each = { reads = "ConsumedReadCapacityUnits", writes = "ConsumedWriteCapacityUnits" }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/DynamoDB"
        metric_name = metric_query.value
        dimensions  = { TableName = "${local.prefix}-${each.key}" }
        stat        = "Sum"
        period      = local.alarm_period
      }
    }
  }
}

# Uploads and downloads go from the app straight to the media bucket with
# presigned URLs, past the API, its firewall and the alarms above, and S3
# bills every request, refused ones included. Each needs a URL from the api
# function first, so far more than real use is a URL being replayed. The
# bucket's name is random (infra/media.tf), so the queries find its request
# metrics by their configuration's name.
locals {
  media_metrics = "FROM SCHEMA(\"AWS/S3\", BucketName, FilterId) WHERE FilterId = '${local.prefix}-media'"
}

resource "aws_cloudwatch_metric_alarm" "media_requests" {
  for_each = { uploads = "PutRequests", downloads = "GetRequests" }

  alarm_name          = "${local.prefix}-media-${each.key}"
  alarm_description   = "The media bucket had more than ${var.media_requests_alarm} ${each.value} in 5 minutes."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.media_requests_alarm
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "requests"
    expression  = "SELECT SUM(${each.value}) ${local.media_metrics}"
    label       = each.value
    period      = local.alarm_period
    return_data = true
  }
}

# What downloads cost is the data sent, not the requests: one 51 MiB
# download costs as much as about 11,000 GET requests.
resource "aws_cloudwatch_metric_alarm" "media_download_bytes" {
  alarm_name          = "${local.prefix}-media-download-bytes"
  alarm_description   = "More than ${var.media_download_gib_alarm} GiB was downloaded from the media bucket in 5 minutes."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.media_download_gib_alarm * 1073741824
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "bytes"
    expression  = "SELECT SUM(BytesDownloaded) ${local.media_metrics}"
    label       = "BytesDownloaded"
    period      = local.alarm_period
    return_data = true
  }
}

# What the media bucket holds, from S3's free daily storage metric. Each
# account may upload 500 MiB a day, and uploads nobody fetches stay 30
# days, billed all the while: many accounts can park a lot without sending
# anything. The metric is named by the bucket, whose name is random
# (../media.tf), so it is looked up: before the app stack's first deploy
# there is none, and the alarm comes with the next run of this stack.
data "aws_s3_buckets" "media" {
  prefix        = "${local.prefix}-media-"
  bucket_region = local.region
}

locals {
  # Every bucket with the name, though the app stack makes one.
  media_buckets = sort([for b in coalesce(data.aws_s3_buckets.media.buckets, []) : b.name])
}

resource "aws_cloudwatch_metric_alarm" "media_stored" {
  count = length(local.media_buckets) > 0 ? 1 : 0

  alarm_name        = "${local.prefix}-media-stored"
  alarm_description = "The media bucket holds more than ${var.media_stored_gib_alarm} GiB."
  # S3 reports it once a day, hours late: the alarm looks at the last two
  # days, so that it always has a figure.
  evaluation_periods  = 2
  datapoints_to_alarm = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.media_stored_gib_alarm * 1073741824
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "stored"
    expression  = "SUM(METRICS())"
    label       = "BucketSizeBytes"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = local.media_buckets
    content {
      id = "bucket${metric_query.key}"
      metric {
        namespace   = "AWS/S3"
        metric_name = "BucketSizeBytes"
        dimensions  = { BucketName = metric_query.value, StorageType = "StandardStorage" }
        stat        = "Average"
        period      = 86400
      }
    }
  }
}

# The api function's request counts, as the app stack's metric filters
# make them (infra/metrics.tf; the namespace must stay the same as there).
# They show what a campaign does: many accounts, each within its own
# limits, never make the invocations alarm, but each of them registers and
# takes tokens. Each alarm sums an hour.
locals {
  counts_namespace = "${local.prefix}/api"
  counts_period    = 3600

  count_alarms = {
    registrations = {
      metric      = "Registrations"
      threshold   = var.registrations_alarm
      description = "More than ${var.registrations_alarm} accounts were registered or set up again in an hour."
    }
    limit-hits = {
      metric      = "Limited"
      threshold   = var.limit_hits_alarm
      description = "The api function answered 429 (a limit refused the request) more than ${var.limit_hits_alarm} times in an hour."
    }
    invalid-tokens = {
      metric      = "InvalidToken"
      threshold   = var.refusals_alarm
      description = "More than ${var.refusals_alarm} sends or uploads were refused for an invalid send or media token in an hour."
    }
    init-data-rejected = {
      metric      = "InitDataRejected"
      threshold   = var.refusals_alarm
      description = "More than ${var.refusals_alarm} requests were refused in an hour for Telegram data that didn't check out."
    }
    signature-rejected = {
      metric      = "SignatureRejected"
      threshold   = var.refusals_alarm
      description = "More than ${var.refusals_alarm} requests were refused in an hour for a device signature that didn't check out."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "counts" {
  for_each = local.count_alarms

  alarm_name          = "${local.prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = local.counts_namespace
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = local.counts_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The account expiry (../functions.tf; docs/deployment.md, Account expiry),
# over an hour, as it runs every 15 minutes: a run that failed, paused (no
# account recorded a recent month of use: logins may have stopped recording
# it, so nothing is deleted) or passed over stuck accounts logs an error
# (ExpiryProblems); one that crashed or timed out is dropped (api's
# AsyncEventsDropped: the schedule is its only event, never tried again);
# and a login that couldn't record its month logs one too (UseNotRecorded),
# which a year on would make accounts in use look unused. The metric
# filters are in ../metrics.tf.
resource "aws_cloudwatch_metric_alarm" "account_expiry" {
  alarm_name          = "${local.prefix}-account-expiry"
  alarm_description   = "In the last hour the account expiry failed, paused (no recent month of use: it deletes nothing) or got stuck on accounts, or a login couldn't record its month of use."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "problems"
    expression  = "FILL(expiry, 0) + FILL(dropped, 0) + FILL(unrecorded, 0)"
    label       = "Expiry problems"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = {
      expiry     = { namespace = local.counts_namespace, metric = "ExpiryProblems", dimensions = {} }
      unrecorded = { namespace = local.counts_namespace, metric = "UseNotRecorded", dimensions = {} }
      dropped    = { namespace = "AWS/Lambda", metric = "AsyncEventsDropped", dimensions = { FunctionName = "${local.prefix}-api" } }
    }
    content {
      id = metric_query.key
      metric {
        namespace   = metric_query.value.namespace
        metric_name = metric_query.value.metric
        dimensions  = metric_query.value.dimensions
        stat        = "Sum"
        period      = local.counts_period
      }
    }
  }
}

# Batches of send and media tokens signed, the two together.
resource "aws_cloudwatch_metric_alarm" "token_requests" {
  alarm_name          = "${local.prefix}-token-requests"
  alarm_description   = "More than ${var.token_requests_alarm} batches of send and media tokens were signed in an hour."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.token_requests_alarm
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "batches"
    expression  = "FILL(send, 0) + FILL(media, 0)"
    label       = "Token batches"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { send = "SendTokenRequests", media = "MediaTokenRequests" }
    content {
      id = metric_query.key
      metric {
        namespace   = local.counts_namespace
        metric_name = metric_query.value
        stat        = "Sum"
        period      = local.counts_period
      }
    }
  }
}

# --- us-east-1: CloudFront and its firewall --------------------------------
# Their metrics are there, whatever the app's region, and an alarm notifies
# only a topic in its own region: a second topic, subscribed like the first.
# The change alerts on what is recorded there too (IAM, CloudFront, the
# firewall…) publish to it as well (audit.tf), and so do AWS's cost anomaly
# alerts (at the end).

resource "aws_sns_topic" "edge_alerts" {
  provider = aws.global
  name     = "${local.prefix}-edge-alerts"
}

data "aws_iam_policy_document" "edge_alerts_topic" {
  statement {
    sid       = "AlarmsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.edge_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  # The change alerts recorded in us-east-1: IAM, CloudFront, the firewall… (audit.tf).
  statement {
    sid       = "ChangeAlertsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.edge_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = [
        aws_cloudwatch_event_rule.global_changes.arn,
        aws_cloudwatch_event_rule.edge_changes.arn,
      ]
    }
  }

  # AWS's cost anomaly alerts (at the end), for this account's
  # subscriptions: the condition AWS documents. aws:SourceArn could name the
  # one subscription, but nobody else may make one (the deploy role has no
  # Cost Explorer rights). The topic isn't encrypted, so the service needs
  # no rights on a key.
  statement {
    sid       = "CostAnomalyAlertsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.edge_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["costalerts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "edge_alerts" {
  provider = aws.global
  arn      = aws_sns_topic.edge_alerts.arn
  policy   = data.aws_iam_policy_document.edge_alerts_topic.json
}

# The API's distribution answering with server errors: the function URL
# failing or out of reach, or the api function answering 5xx (503 while a
# table refuses requests at its cap, or while attachments are paused). The
# distribution's ID is random (../edge.tf), so the query takes every
# distribution in the account: the app stack makes one. A share is noisy
# while there are few requests, so it must hold for 15 minutes.
resource "aws_cloudwatch_metric_alarm" "edge_5xx" {
  provider = aws.global

  alarm_name          = "${local.prefix}-edge-5xx"
  alarm_description   = "More than ${var.edge_5xx_rate_alarm}% of CloudFront's answers were 5xx errors, in each of the last three 5-minute periods."
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.edge_5xx_rate_alarm
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.edge_alerts.arn]
  ok_actions          = [aws_sns_topic.edge_alerts.arn]

  metric_query {
    id          = "rate"
    expression  = "SELECT AVG(\"5xxErrorRate\") FROM SCHEMA(\"AWS/CloudFront\", DistributionId, Region)"
    label       = "5xxErrorRate"
    period      = local.alarm_period
    return_data = true
  }
}

# Requests reaching CloudFront: what the edge bills. CloudFront bills each
# request the firewall lets through, and the firewall each it looks at,
# blocked or not, with no ceiling. A flood spread over many addresses, each
# under the firewall's limits, never makes firewall-blocks fire; this
# counts every request CloudFront receives, whether or not it reaches the
# api function. The query takes every distribution in the account, as
# edge_5xx's: the app stack makes one.
resource "aws_cloudwatch_metric_alarm" "edge_requests" {
  provider = aws.global

  alarm_name          = "${local.prefix}-edge-requests"
  alarm_description   = "CloudFront received more than ${var.edge_requests_alarm} requests in 5 minutes."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.edge_requests_alarm
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.edge_alerts.arn]
  ok_actions          = [aws_sns_topic.edge_alerts.arn]

  metric_query {
    id          = "requests"
    expression  = "SELECT SUM(Requests) FROM SCHEMA(\"AWS/CloudFront\", DistributionId, Region)"
    label       = "Requests"
    period      = local.alarm_period
    return_data = true
  }
}

# The firewall blocking requests, all its rules together: a flood is being
# held off, or real users behind a busy address are refused. The firewall
# still bills each blocked request (CloudFront doesn't, since October
# 2024). Only where the app stack puts the firewall (FIREWALL), production
# by default.
locals {
  firewall = coalesce(var.firewall, var.github_environment == "production")
}

resource "aws_cloudwatch_metric_alarm" "firewall_blocks" {
  count    = local.firewall ? 1 : 0
  provider = aws.global

  alarm_name        = "${local.prefix}-firewall-blocks"
  alarm_description = "The firewall blocked more than ${var.firewall_blocks_alarm} requests in 5 minutes."
  namespace         = "AWS/WAFV2"
  metric_name       = "BlockedRequests"
  # The web ACL's metric name, as the app stack sets it (../edge.tf).
  dimensions          = { WebACL = "${local.prefix}-api", Rule = "ALL" }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.firewall_blocks_alarm
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.edge_alerts.arn]
  ok_actions          = [aws_sns_topic.edge_alerts.arn]
}

# AWS's cost anomaly alerts. Cost Anomaly Detection learns what each AWS
# service usually costs the account and reports spending above that; this
# sends each anomaly whose total cost impact (above what was expected, over
# all its days) reaches cost_anomaly_alert_usd, as soon as it is found. It
# is free, and it watches every service, those no alarm here reads too, but
# it is slow: it runs about three times a day on billing data up to 24
# hours old, a new monitor starts after 24 hours, and a service needs 10
# days of history. The alarms above notice a flood first.
#
# The monitor is the AWS services one (DIMENSIONAL, SERVICE), which AWS
# manages, and an account may have only one: creating it fails where one
# already exists (AWS makes one, with a daily email summary, when Cost
# Explorer is first turned on). Delete that one first (docs/deployment.md).
# Cost Explorer's API is in us-east-1 whatever the provider's region, and
# alerts sent as anomalies are found (IMMEDIATE) go only to an SNS topic:
# both live next to the edge topic, which takes them.
resource "aws_ce_anomaly_monitor" "services" {
  provider = aws.global

  name              = "${local.prefix}-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "costs" {
  provider = aws.global

  name             = "${local.prefix}-cost-anomalies"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.edge_alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.cost_anomaly_alert_usd)]
    }
  }

  depends_on = [aws_sns_topic_policy.edge_alerts]
}
