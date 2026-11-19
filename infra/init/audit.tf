# A record of who changed what in the account (CloudTrail), emails when
# permissions, functions, secrets or the record itself change (EventBridge
# rules to the alerts topics), and IAM Access Analyzer, which says when
# something in the account can be reached from outside it.
#
# The trail records the account's management events: the calls that read
# or change its settings (IAM, Lambda, buckets' settings, parameters,
# CloudFront…), by admins, by CI's deploy role and by AWS services, with who
# made each, from which IP address and when, in every region. It records no
# data events: the functions' reads and writes of table items and
# attachments, and their invocations, aren't in it, so it holds nothing
# about users (docs/data.md). The first trail of management events in an
# account is free; its bucket costs cents a month.
#
# It lives in this stack, which only an admin applies, and the deploy role
# is denied every CloudTrail call and every call on the trail's bucket
# (github_deploy.tf, deploy_limits), so a deploy can't stop the record,
# narrow it or delete what it holds. An admin can; the alerts say when.

locals {
  audit_trail_name = "${local.prefix}-audit"
  # From its name: the bucket's policy names the trail, and the trail waits
  # for that policy.
  audit_trail_arn = "arn:${local.partition}:cloudtrail:${local.region}:${local.account_id}:trail/${local.audit_trail_name}"
}

# The name ends in random characters, not the account ID.
resource "aws_s3_bucket" "audit" {
  bucket_prefix = "${local.prefix}-audit-"
}

# A file deleted or overwritten stays, as an older version, for 30 days.
resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket = aws_s3_bucket.audit.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Each file goes after audit_retention_days, and its older version 30 days
# later (S3 then removes the delete marker left behind). The bucket policy's
# deny on deletes doesn't apply to this: S3 deletes expired files itself.
resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "expire-old-records"
    status = "Enabled"

    filter {}

    expiration {
      days = var.audit_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit]
}

# Only this trail may write, only under this account's AWSLogs/, and nobody
# may delete a file: to delete one early, an admin must first change this
# policy, which sends an alert (aws_cloudwatch_event_rule.changes).
data "aws_iam_policy_document" "audit_bucket" {
  statement {
    sid       = "TrailChecksAcl"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.audit.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }
  }

  statement {
    sid       = "TrailWrites"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.audit_trail_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  statement {
    sid       = "DenyDeletingRecords"
    effect    = "Deny"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.audit.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.audit.arn,
      "${aws_s3_bucket.audit.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id
  policy = data.aws_iam_policy_document.audit_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.audit]
}

# One trail for the whole account: every region, global services' events
# (IAM, CloudFront, the firewall: recorded in us-east-1) included, and a
# signed digest of each hour's files, so a changed or deleted file shows
# (aws cloudtrail validate-logs). Management events only: no data events,
# so nothing about the app's users, and no Insights (billed).
resource "aws_cloudtrail" "audit" {
  name                          = local.audit_trail_name
  s3_bucket_name                = aws_s3_bucket.audit.id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  advanced_event_selector {
    name = "Management events only"

    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  depends_on = [aws_s3_bucket_policy.audit]
}

# --- Change alerts -----------------------------------------------------------
# EventBridge rules on the default bus, matching CloudTrail's management
# events as AWS delivers them: free, and only calls that change something
# (the rules see no reads). An event reaches the bus of the region it was
# recorded in: the app's region for its functions, buckets, parameters and
# the trail; us-east-1 for IAM, CloudFront and the firewall. Each rule
# emails its region's alerts topic (alerts.tf).
#
# Deploys change functions, buckets, parameters, CloudFront and the
# firewall, and sign code, as their job: the rules on those leave out the
# deploy role's own calls, which CI's public logs show (the plan and the
# apply) and the trail records. The deploy role never changes IAM (but for
# the functions' roles' policies, and only when the app stack changes them)
# or CloudTrail (denied), so the rules on those include its calls.

locals {
  # How CloudTrail names the deploy role's sessions (github_deploy.tf).
  deploy_sessions = "arn:${local.partition}:sts::${local.account_id}:assumed-role/${local.prefix}-github-deploy/"

  # Calls by anyone but the deploy role: any caller ARN but its sessions',
  # or none (AWS services, and other accounts, whose calls carry none).
  not_deploy_role = {
    "$or" = [
      { arn = [{ "anything-but" = { prefix = local.deploy_sessions } }] },
      { arn = [{ exists = false }] },
    ]
  }

  # What the email says: what was called, by whom, from where and when,
  # whether it was refused, and how to get the whole record. A field the
  # event lacks (the error, when the call succeeded) is left blank.
  change_alert = {
    input_paths = {
      event   = "$.detail.eventName"
      service = "$.detail.eventSource"
      caller  = "$.detail.userIdentity.arn"
      kind    = "$.detail.userIdentity.type"
      ip      = "$.detail.sourceIPAddress"
      region  = "$.detail.awsRegion"
      time    = "$.detail.eventTime"
      error   = "$.detail.errorCode"
      id      = "$.detail.eventID"
    }
    input_template = <<-EOT
      "<aws.events.rule-name>: <event> (<service>)"
      "Who: <caller> (<kind>), from <ip>"
      "Where and when: <region>, <time>"
      "Refused: <error> (blank if it went through)"
      "The whole record (within 90 days): aws cloudtrail lookup-events --region <region> --lookup-attributes AttributeKey=EventId,AttributeValue=<id>"
    EOT
  }

  # IAM calls that change something (not Get, List, Simulate, Generate,
  # Tag). On EventBridge and SNS they cover the rules and topics the alerts
  # go through, too.
  change_prefixes = [
    for p in [
      "Add", "Attach", "Change", "Create", "Deactivate", "Delete", "Detach", "Disable",
      "Enable", "Put", "Remove", "Reset", "Resync", "Set", "Subscribe", "Unsubscribe",
      "Update", "Upload",
    ] : { prefix = p }
  ]
}

# In the app's region, by anyone but the deploy role: the functions (code,
# settings, URLs, permissions, code signing), the signing profile, the
# buckets' settings (policies, public access, versioning, lifecycle…), the
# parameters (the secrets), and the tables' copies and policies (which the
# deploy role is denied anyway).
resource "aws_cloudwatch_event_rule" "changes" {
  name        = "${local.prefix}-changes"
  description = "Changes to functions, code signing, buckets, parameters and table copies, by anyone but the deploy role"

  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      "$or" = [
        { eventSource = ["lambda.amazonaws.com", "signer.amazonaws.com", "s3.amazonaws.com"] },
        {
          eventSource = ["ssm.amazonaws.com"]
          eventName = [
            "PutParameter", "DeleteParameter", "DeleteParameters", "LabelParameterVersion",
            "UnlabelParameterVersion", "PutResourcePolicy", "DeleteResourcePolicy",
          ]
        },
        {
          eventSource = ["dynamodb.amazonaws.com"]
          eventName = [
            "ExportTableToPointInTime", "ImportTable", "CreateBackup", "RestoreTableFromBackup",
            "RestoreTableToPointInTime", "PutResourcePolicy", "DeleteResourcePolicy",
            "EnableKinesisStreamingDestination", "UpdateKinesisStreamingDestination",
          ]
        },
      ]
      userIdentity = local.not_deploy_role
    }
  })
}

resource "aws_cloudwatch_event_target" "changes" {
  rule = aws_cloudwatch_event_rule.changes.name
  arn  = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths    = local.change_alert.input_paths
    input_template = local.change_alert.input_template
  }
}

# In the app's region, by anyone, the deploy role included: the trail
# (stopped, deleted, changed, or another one made), Access Analyzer, and the
# rules and topic these alerts go through.
resource "aws_cloudwatch_event_rule" "audit_changes" {
  name        = "${local.prefix}-audit-changes"
  description = "Changes to CloudTrail, Access Analyzer, EventBridge rules and SNS topics, by anyone"

  # Publishing isn't a change (and isn't a management event, but an alert
  # must never match the alert it sends).
  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["cloudtrail.amazonaws.com", "access-analyzer.amazonaws.com", "events.amazonaws.com", "sns.amazonaws.com"]
      eventName   = [{ "anything-but" = ["Publish", "PublishBatch", "PutEvents"] }]
    }
  })
}

resource "aws_cloudwatch_event_target" "audit_changes" {
  rule = aws_cloudwatch_event_rule.audit_changes.name
  arn  = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths    = local.change_alert.input_paths
    input_template = local.change_alert.input_template
  }
}

# In us-east-1, by anyone, the deploy role included: IAM (roles, policies,
# users, access keys…), and there too the rules and topic these alerts go
# through, unless that is the app's region, where the rule above has them.
resource "aws_cloudwatch_event_rule" "iam_changes" {
  provider = aws.global

  name        = "${local.prefix}-iam-changes"
  description = "Changes to IAM, EventBridge rules and SNS topics, by anyone"

  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = concat(["iam.amazonaws.com"], local.region == "us-east-1" ? [] : ["events.amazonaws.com", "sns.amazonaws.com"])
      eventName   = local.change_prefixes
    }
  })
}

resource "aws_cloudwatch_event_target" "iam_changes" {
  provider = aws.global

  rule = aws_cloudwatch_event_rule.iam_changes.name
  arn  = aws_sns_topic.edge_alerts.arn

  input_transformer {
    input_paths    = local.change_alert.input_paths
    input_template = local.change_alert.input_template
  }
}

# In us-east-1, by anyone but the deploy role: CloudFront and the firewall.
resource "aws_cloudwatch_event_rule" "edge_changes" {
  provider = aws.global

  name        = "${local.prefix}-edge-changes"
  description = "Changes to CloudFront and the firewall, by anyone but the deploy role"

  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource  = ["cloudfront.amazonaws.com", "wafv2.amazonaws.com"]
      userIdentity = local.not_deploy_role
    }
  })
}

resource "aws_cloudwatch_event_target" "edge_changes" {
  provider = aws.global

  rule = aws_cloudwatch_event_rule.edge_changes.name
  arn  = aws_sns_topic.edge_alerts.arn

  input_transformer {
    input_paths    = local.change_alert.input_paths
    input_template = local.change_alert.input_template
  }
}

# --- IAM Access Analyzer -----------------------------------------------------
# Free for access from outside the account: it reads the policies of the
# account's roles, buckets, functions, topics and so on in this region, and
# makes a finding for each that lets another account, or anyone, in. Some
# are on purpose (docs/deployment.md, Audit trail and change alerts): read
# them once and archive them. A new active finding is emailed.
resource "aws_accessanalyzer_analyzer" "account" {
  analyzer_name = "${local.prefix}-access"
  type          = "ACCOUNT"
}

resource "aws_cloudwatch_event_rule" "access_findings" {
  name        = "${local.prefix}-access-findings"
  description = "New active IAM Access Analyzer findings: access from outside the account"

  event_pattern = jsonencode({
    source        = ["aws.access-analyzer"]
    "detail-type" = ["Access Analyzer Finding"]
    detail = {
      status    = ["ACTIVE"]
      isDeleted = [false]
    }
  })
}

resource "aws_cloudwatch_event_target" "access_findings" {
  rule = aws_cloudwatch_event_rule.access_findings.name
  arn  = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      type      = "$.detail.resourceType"
      resource  = "$.detail.resource"
      principal = "$.detail.principal"
      actions   = "$.detail.action"
      public    = "$.detail.isPublic"
      error     = "$.detail.error"
      id        = "$.detail.id"
      region    = "$.region"
      analyzer  = "$.resources[0]"
    }
    input_template = <<-EOT
      "<aws.events.rule-name>: <resource> (<type>) can be reached from outside the account"
      "By: <principal> (anyone: <public>), to: <actions>"
      "Not analyzed: <error> (blank if it was)"
      "The finding: aws accessanalyzer get-finding --region <region> --analyzer-arn <analyzer> --id <id>"
    EOT
  }
}
