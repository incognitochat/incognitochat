# Checks the read-only stats role (stats_reader.tf): who may assume it
# (exactly one GitHub environment of one repository), and what it may do
# (read costs, and in production metrics; nothing else, nothing written).
# Nothing touches AWS: the provider has fake credentials, and the resources
# the documents name are overridden, so "apply" creates nothing. Run by CI
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
  github_oidc_subject_prefix = "repo:example@1/example@2"
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
  target = aws_iam_openid_connect_provider.github
  values = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
}

override_resource {
  target = aws_iam_role.stats
  values = { arn = "arn:aws:iam::123456789012:role/incognitochat-production-github-stats" }
}

override_resource {
  target = aws_iam_role_policy.stats
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

run "production_reads_metrics_and_costs" {
  command = apply

  variables {
    stats_github_oidc_subject = "repo:site@3/website@4:environment:stats"
    stats_read_metrics        = true
  }

  plan_options {
    target = [aws_iam_role.stats, aws_iam_role_policy.stats]
  }

  assert {
    condition     = aws_iam_role.stats[0].name == "incognitochat-production-github-stats"
    error_message = "The stats role is misnamed."
  }

  # One statement: GitHub's OIDC provider, for STS, only that environment
  # of that repository.
  assert {
    condition     = length(jsondecode(data.aws_iam_policy_document.stats_trust[0].json).Statement) == 1
    error_message = "The stats role's trust policy has more than one statement."
  }
  assert {
    condition = jsondecode(data.aws_iam_policy_document.stats_trust[0].json).Statement[0] == {
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:site@3/website@4:environment:stats"
        }
      }
    }
    error_message = "The stats role trusts more than the stats environment of the website repository."
  }

  # Exactly these two reads, each in its own region, and nothing else.
  assert {
    condition = sort(flatten([
      for s in jsondecode(data.aws_iam_policy_document.stats[0].json).Statement : s.Action if s.Effect == "Allow"
    ])) == tolist(["ce:GetCostAndUsage", "cloudwatch:GetMetricData"])
    error_message = "The production stats role may do more than read costs and metrics."
  }
  assert {
    condition = {
      for s in jsondecode(data.aws_iam_policy_document.stats[0].json).Statement :
      s.Action => s.Condition
      } == {
      "ce:GetCostAndUsage"       = { StringEquals = { "aws:RequestedRegion" = "us-east-1" } }
      "cloudwatch:GetMetricData" = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } }
    }
    error_message = "The stats role's reads aren't each limited to their region."
  }
}

run "dev_reads_costs_only" {
  command = apply

  variables {
    github_environment        = "dev"
    stats_github_oidc_subject = "repo:site@3/website@4:environment:stats"
    stats_read_metrics        = false
  }

  plan_options {
    target = [aws_iam_role.stats, aws_iam_role_policy.stats]
  }

  assert {
    condition = flatten([
      for s in jsondecode(data.aws_iam_policy_document.stats[0].json).Statement : s.Action if s.Effect == "Allow"
    ]) == ["ce:GetCostAndUsage"]
    error_message = "The dev stats role may do more than read costs."
  }

  assert {
    condition     = jsondecode(data.aws_iam_policy_document.stats_trust[0].json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:site@3/website@4:environment:stats"
    error_message = "The dev stats role trusts the wrong subject."
  }
}

run "no_subject_no_role" {
  command = plan

  plan_options {
    target = [aws_iam_role.stats, aws_iam_role_policy.stats]
  }

  assert {
    condition     = length(aws_iam_role.stats) == 0 && length(aws_iam_role_policy.stats) == 0
    error_message = "A stats role is made without a subject."
  }
}

run "another_environment_is_refused" {
  command = plan

  variables {
    stats_github_oidc_subject = "repo:site@3/website@4:ref:refs/heads/main"
  }

  expect_failures = [var.stats_github_oidc_subject]
}

# A subject without IDs would match a repository made again under the name.
run "a_subject_without_ids_is_refused" {
  command = plan

  variables {
    stats_github_oidc_subject = "repo:site/website:environment:stats"
  }

  expect_failures = [var.stats_github_oidc_subject]
}

run "a_wildcard_is_refused" {
  command = plan

  variables {
    stats_github_oidc_subject = "repo:site@3/*@4:environment:stats"
  }

  expect_failures = [var.stats_github_oidc_subject]
}
