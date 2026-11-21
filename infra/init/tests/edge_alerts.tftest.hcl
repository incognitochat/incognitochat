# Plans what watches the edge's bill, in us-east-1: AWS's cost anomaly
# alerts and the alarm on CloudFront's requests, both sent to the edge
# alerts topic, and checks the topic's policy, which lets Cost Anomaly
# Detection publish to it. Nothing touches AWS: the provider has fake
# credentials and makes no calls (policy documents are rendered locally),
# and what only AWS would know (the topic's, the monitor's and the rules'
# ARNs) is overridden. Run by CI (terraform test).

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

# For the apply below, so that it creates nothing. The plan that needs the
# ARNs has its own overrides, used during the plan: values made up for the
# other computed attributes then would differ from an apply's.
override_resource {
  target = aws_sns_topic.edge_alerts
  values = { arn = "arn:aws:sns:us-east-1:123456789012:incognitochat-production-edge-alerts" }
}

# The topic's policy names the change alerts' rules too.
override_resource {
  target = aws_cloudwatch_event_rule.global_changes
  values = { arn = "arn:aws:events:us-east-1:123456789012:rule/incognitochat-production-global-changes" }
}

override_resource {
  target = aws_cloudwatch_event_rule.edge_changes
  values = { arn = "arn:aws:events:us-east-1:123456789012:rule/incognitochat-production-edge-changes" }
}

run "edge_alerts" {
  command = plan

  override_resource {
    target          = aws_sns_topic.edge_alerts
    override_during = plan
    values          = { arn = "arn:aws:sns:us-east-1:123456789012:incognitochat-production-edge-alerts" }
  }

  override_resource {
    target          = aws_ce_anomaly_monitor.services
    override_during = plan
    values          = { arn = "arn:aws:ce::123456789012:anomalymonitor/01234567-89ab-cdef-0123-456789abcdef" }
  }

  plan_options {
    target = [
      aws_ce_anomaly_subscription.costs,
      aws_cloudwatch_metric_alarm.edge_requests,
    ]
  }

  # The monitor over every AWS service, the one an account may have.
  assert {
    condition = (
      aws_ce_anomaly_monitor.services.monitor_type == "DIMENSIONAL"
      && aws_ce_anomaly_monitor.services.monitor_dimension == "SERVICE"
      && length(aws_ce_anomaly_subscription.costs.monitor_arn_list) == 1
      && aws_ce_anomaly_subscription.costs.monitor_arn_list[0] == "arn:aws:ce::123456789012:anomalymonitor/01234567-89ab-cdef-0123-456789abcdef"
    )
    error_message = "The cost anomaly alerts don't come from a monitor of every AWS service."
  }

  # Sent as each anomaly is found, which only an SNS topic takes: the edge
  # alerts topic, already subscribed.
  assert {
    condition = (
      aws_ce_anomaly_subscription.costs.frequency == "IMMEDIATE"
      && length(aws_ce_anomaly_subscription.costs.subscriber) == 1
      && one(aws_ce_anomaly_subscription.costs.subscriber).type == "SNS"
      && one(aws_ce_anomaly_subscription.costs.subscriber).address == "arn:aws:sns:us-east-1:123456789012:incognitochat-production-edge-alerts"
    )
    error_message = "The cost anomaly alerts don't go to the edge alerts topic as they are found."
  }

  # Anomalies whose total cost impact reaches $5, by default.
  assert {
    condition = (
      length(aws_ce_anomaly_subscription.costs.threshold_expression) == 1
      && length(aws_ce_anomaly_subscription.costs.threshold_expression[0].dimension) == 1
      && length(aws_ce_anomaly_subscription.costs.threshold_expression[0].and) == 0
      && length(aws_ce_anomaly_subscription.costs.threshold_expression[0].or) == 0
      && aws_ce_anomaly_subscription.costs.threshold_expression[0].dimension[0].key == "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      && aws_ce_anomaly_subscription.costs.threshold_expression[0].dimension[0].match_options == toset(["GREATER_THAN_OR_EQUAL"])
      && aws_ce_anomaly_subscription.costs.threshold_expression[0].dimension[0].values == toset(["5"])
    )
    error_message = "The cost anomaly alerts don't send anomalies whose total impact reaches $5 by default."
  }

  # Every distribution's requests, summed over 5 minutes, to the edge topic.
  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.edge_requests.metric_query) == 1
      && one(aws_cloudwatch_metric_alarm.edge_requests.metric_query).expression == "SELECT SUM(Requests) FROM SCHEMA(\"AWS/CloudFront\", DistributionId, Region)"
      && one(aws_cloudwatch_metric_alarm.edge_requests.metric_query).period == 300
      && one(aws_cloudwatch_metric_alarm.edge_requests.metric_query).return_data
    )
    error_message = "The edge-requests alarm doesn't sum CloudFront's requests over 5 minutes, every distribution together."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.edge_requests.threshold == 30000
      && aws_cloudwatch_metric_alarm.edge_requests.comparison_operator == "GreaterThanThreshold"
      && aws_cloudwatch_metric_alarm.edge_requests.evaluation_periods == 1
      && aws_cloudwatch_metric_alarm.edge_requests.alarm_actions == toset(["arn:aws:sns:us-east-1:123456789012:incognitochat-production-edge-alerts"])
      && aws_cloudwatch_metric_alarm.edge_requests.ok_actions == toset(["arn:aws:sns:us-east-1:123456789012:incognitochat-production-edge-alerts"])
    )
    error_message = "The edge-requests alarm doesn't fire past 30,000 requests in 5 minutes, to the edge alerts topic."
  }
}

# Cost Anomaly Detection may publish to the topic, for this account only.
# Policy documents are read only once the resources they name exist, which
# here means overridden in an apply: it creates nothing.
run "edge_alerts_topic_policy" {
  command = apply

  plan_options {
    target = [data.aws_iam_policy_document.edge_alerts_topic]
  }

  assert {
    condition = length([
      for s in jsondecode(data.aws_iam_policy_document.edge_alerts_topic.json).Statement : s
      if s.Effect == "Allow"
      && s.Principal == { Service = "costalerts.amazonaws.com" }
      && flatten([s.Action]) == ["sns:Publish"]
      && flatten([s.Resource]) == ["arn:aws:sns:us-east-1:123456789012:incognitochat-production-edge-alerts"]
      && try(s.Condition, null) == { StringEquals = { "aws:SourceAccount" = "123456789012" } }
    ]) == 1
    error_message = "The edge alerts topic doesn't let Cost Anomaly Detection publish for this account alone."
  }

  # Nobody else gets in with it: CloudWatch and EventBridge as before.
  assert {
    condition = toset(flatten([
      for s in jsondecode(data.aws_iam_policy_document.edge_alerts_topic.json).Statement : flatten([s.Principal.Service])
    ])) == toset(["cloudwatch.amazonaws.com", "events.amazonaws.com", "costalerts.amazonaws.com"])
    error_message = "The edge alerts topic lets another service publish."
  }
}

# The thresholds follow their variables.
run "edge_alerts_thresholds" {
  command = plan

  variables {
    cost_anomaly_alert_usd = 25.5
    edge_requests_alarm    = 6000
  }

  plan_options {
    target = [
      aws_ce_anomaly_subscription.costs,
      aws_cloudwatch_metric_alarm.edge_requests,
    ]
  }

  assert {
    condition     = aws_ce_anomaly_subscription.costs.threshold_expression[0].dimension[0].values == toset(["25.5"])
    error_message = "The cost anomaly alerts' threshold doesn't follow cost_anomaly_alert_usd."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.edge_requests.threshold == 6000
    error_message = "The edge-requests alarm's threshold doesn't follow edge_requests_alarm."
  }
}

run "cost_anomaly_alert_usd_zero" {
  command = plan

  variables {
    cost_anomaly_alert_usd = 0
  }

  plan_options {
    target = [aws_ce_anomaly_subscription.costs]
  }

  expect_failures = [var.cost_anomaly_alert_usd]
}

run "edge_requests_alarm_negative" {
  command = plan

  variables {
    edge_requests_alarm = -1
  }

  plan_options {
    target = [aws_cloudwatch_metric_alarm.edge_requests]
  }

  expect_failures = [var.edge_requests_alarm]
}
