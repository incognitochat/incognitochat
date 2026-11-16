# Cost and health alerts for the account: a monthly budget and a few
# CloudWatch alarms, all publishing to one SNS topic. They live in this stack
# so that CI, which can't change it, can't silence them either.
#
# The topic starts without subscribers: whoever runs the deployment
# subscribes an address themselves (docs/deployment.md), so no address is
# ever written to the repository or to Terraform state.

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
  limit_amount = tostring(var.monthly_budget_usd)
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
