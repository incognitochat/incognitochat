# Plans the alarms on the WebSocket API's volume (connects and messages),
# which catch a flood held at the throttle, and checks their names,
# queries, thresholds and topic. Nothing touches AWS: the provider has fake
# credentials and makes no calls, and the alerts topic's ARN, which only
# AWS would know, is overridden. Run by CI (terraform test).

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
  target          = aws_sns_topic.alerts
  override_during = plan
  values          = { arn = "arn:aws:sns:eu-west-1:123456789012:incognitochat-production-alerts" }
}

run "ws_requests" {
  command = plan

  plan_options {
    target = [aws_cloudwatch_metric_alarm.ws_requests]
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.ws_requests) == 2
      && aws_cloudwatch_metric_alarm.ws_requests["connects"].alarm_name == "incognitochat-production-ws-connects"
      && aws_cloudwatch_metric_alarm.ws_requests["messages"].alarm_name == "incognitochat-production-ws-messages"
    )
    error_message = "The WebSocket volume alarms aren't ws-connects and ws-messages."
  }

  # Each sums its own metric over 5 minutes, every WebSocket API together:
  # the API's ID is random.
  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.ws_requests["connects"].metric_query) == 1
      && one(aws_cloudwatch_metric_alarm.ws_requests["connects"].metric_query).expression == "SELECT SUM(ConnectCount) FROM SCHEMA(\"AWS/ApiGateway\", ApiId)"
      && one(aws_cloudwatch_metric_alarm.ws_requests["connects"].metric_query).period == 300
      && one(aws_cloudwatch_metric_alarm.ws_requests["connects"].metric_query).return_data
    )
    error_message = "The ws-connects alarm doesn't sum ConnectCount over 5 minutes, every WebSocket API together."
  }

  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.ws_requests["messages"].metric_query) == 1
      && one(aws_cloudwatch_metric_alarm.ws_requests["messages"].metric_query).expression == "SELECT SUM(MessageCount) FROM SCHEMA(\"AWS/ApiGateway\", ApiId)"
      && one(aws_cloudwatch_metric_alarm.ws_requests["messages"].metric_query).period == 300
      && one(aws_cloudwatch_metric_alarm.ws_requests["messages"].metric_query).return_data
    )
    error_message = "The ws-messages alarm doesn't sum MessageCount over 5 minutes, every WebSocket API together."
  }

  # Past 3,000 in 5 minutes by default, half of what the default throttle
  # lets through a route, to the alerts topic, there and back.
  assert {
    condition = alltrue([
      for a in aws_cloudwatch_metric_alarm.ws_requests : (
        a.threshold == 3000
        && a.comparison_operator == "GreaterThanThreshold"
        && a.evaluation_periods == 1
        && a.treat_missing_data == "notBreaching"
        && a.alarm_actions == toset(["arn:aws:sns:eu-west-1:123456789012:incognitochat-production-alerts"])
        && a.ok_actions == toset(["arn:aws:sns:eu-west-1:123456789012:incognitochat-production-alerts"])
      )
    ])
    error_message = "The WebSocket volume alarms don't fire past 3,000 in 5 minutes, to the alerts topic."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.ws_requests["connects"].alarm_description == "More than 3000 WebSocket connects in 5 minutes."
      && aws_cloudwatch_metric_alarm.ws_requests["messages"].alarm_description == "More than 3000 WebSocket messages in 5 minutes."
    )
    error_message = "The WebSocket volume alarms' descriptions don't say what they count."
  }
}

# The threshold follows its variable, for both.
run "ws_requests_threshold" {
  command = plan

  variables {
    ws_requests_alarm = 1200
  }

  plan_options {
    target = [aws_cloudwatch_metric_alarm.ws_requests]
  }

  assert {
    condition     = alltrue([for a in aws_cloudwatch_metric_alarm.ws_requests : a.threshold == 1200])
    error_message = "The WebSocket volume alarms' threshold doesn't follow ws_requests_alarm."
  }
}

run "ws_requests_alarm_zero" {
  command = plan

  variables {
    ws_requests_alarm = 0
  }

  plan_options {
    target = [aws_cloudwatch_metric_alarm.ws_requests]
  }

  expect_failures = [var.ws_requests_alarm]
}

run "ws_requests_alarm_negative" {
  command = plan

  variables {
    ws_requests_alarm = -1
  }

  plan_options {
    target = [aws_cloudwatch_metric_alarm.ws_requests]
  }

  expect_failures = [var.ws_requests_alarm]
}
