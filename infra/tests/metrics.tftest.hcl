# The metric filters on the api function's request counts (metrics.tf):
# the public statistics' two read the top-level counts, in their own units
# (MediaBytes in bytes), and every other filter's metric is a count. Plans
# only: the provider has fake credentials and makes no calls. Run by CI
# (terraform test).

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
  previous_issuer_key            = ""
  previous_media_issuer_key      = ""
  admin_telegram_ids             = ""
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}

run "count_metric_units" {
  command = plan

  plan_options {
    target = [aws_cloudwatch_log_metric_filter.counts]
  }

  assert {
    condition = {
      for k in ["messages", "media-bytes"] : k => {
        pattern = aws_cloudwatch_log_metric_filter.counts[k].pattern
        metric  = one(aws_cloudwatch_log_metric_filter.counts[k].metric_transformation).name
        value   = one(aws_cloudwatch_log_metric_filter.counts[k].metric_transformation).value
        unit    = one(aws_cloudwatch_log_metric_filter.counts[k].metric_transformation).unit
      }
      } == {
      messages      = { pattern = "{ $.messages > 0 }", metric = "Messages", value = "$.messages", unit = "Count" }
      "media-bytes" = { pattern = "{ $.media_bytes > 0 }", metric = "MediaBytes", value = "$.media_bytes", unit = "Bytes" }
    }
    error_message = "The public statistics' filters must read messages (Count) and media_bytes (Bytes)."
  }

  assert {
    condition = alltrue([
      for k, f in aws_cloudwatch_log_metric_filter.counts : one(f.metric_transformation).unit == "Count" if k != "media-bytes"
    ])
    error_message = "Every count metric but MediaBytes is in Count."
  }
}
