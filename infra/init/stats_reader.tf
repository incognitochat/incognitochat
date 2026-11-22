# A read-only role for the public statistics on the project's website. A
# scheduled workflow in the website's repository assumes it through GitHub's
# OIDC, from that repository's "stats" GitHub environment only (which takes
# only its main branch), and reads this account's counts (CloudWatch
# metrics; production only) and costs (Cost Explorer). It can read nothing
# else and change nothing.
#
# Neither call can be narrowed to resources in IAM, only to a region:
# GetMetricData reads every metric in the app's region (counts and sums,
# nothing about anyone), GetCostAndUsage every cost of the account (Cost
# Explorer answers only in us-east-1). What's published is decided by the
# workflow, which is public. The calls cost money (Cost Explorer $0.01 each),
# so the workflow reads costs once a day.
#
# scripts/bootstrap.sh sets stats_github_oidc_subject from STATS_REPO; with
# none, there is no role.
locals {
  stats_reader = var.stats_github_oidc_subject != ""
}

data "aws_iam_policy_document" "stats_trust" {
  count = local.stats_reader ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [var.stats_github_oidc_subject]
    }
  }
}

resource "aws_iam_role" "stats" {
  count = local.stats_reader ? 1 : 0

  name                 = "${local.prefix}-github-stats"
  description          = "Assumed by the website's stats workflow (GitHub OIDC) to read ${var.stats_read_metrics ? "metrics and costs" : "costs"} for the public statistics"
  assume_role_policy   = data.aws_iam_policy_document.stats_trust[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "stats" {
  count = local.stats_reader ? 1 : 0

  statement {
    sid       = "Costs"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = ["us-east-1"]
    }
  }

  dynamic "statement" {
    for_each = var.stats_read_metrics ? [1] : []
    content {
      sid       = "Counts"
      actions   = ["cloudwatch:GetMetricData"]
      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.aws_region]
      }
    }
  }
}

resource "aws_iam_role_policy" "stats" {
  count = local.stats_reader ? 1 : 0

  name   = "read-stats"
  role   = aws_iam_role.stats[0].id
  policy = data.aws_iam_policy_document.stats[0].json
}
