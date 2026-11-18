# GitHub Actions authenticates with short-lived OIDC credentials (no stored
# AWS keys). Only jobs that run in the configured GitHub environment can
# assume the deploy role, and the environment only accepts one branch (set by
# scripts/bootstrap.sh).
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "deploy_trust" {
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
      values   = ["${var.github_oidc_subject_prefix}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${local.prefix}-github-deploy"
  description          = "Assumed by GitHub Actions (${var.github_environment} environment) to deploy the app stack"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy.arn
}

# Least privilege: the deploy role can manage only the app stack's own
# resources (by name prefix), with only the calls Terraform makes for them,
# and read/write only the app/ prefix of the state bucket. Data and lasting
# access are denied outright (deploy_no_items and deploy_limits, below).
data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "StateBucketList"
    actions   = ["s3:ListBucket"]
    resources = [local.arns.state_bucket]
  }

  statement {
    sid       = "AppStateReadWrite"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.arns.state_bucket}/app/*"]
  }

  # The media bucket's configuration, not its contents: the deploy role can't
  # read, write or delete the encrypted attachments (deploy_limits). Only the
  # settings the app stack manages (../media.tf), so a change to any of them
  # shows in the next plan and is undone.
  statement {
    sid = "MediaBucket"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:ListBucket",
      "s3:GetBucket*",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketCORS",
      "s3:PutBucketPolicy",
      "s3:PutBucketTagging",
      "s3:DeleteBucketPolicy",
      "s3:GetAccelerateConfiguration",
      "s3:GetEncryptionConfiguration",
      "s3:PutEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      # Request metrics (also needed to delete them).
      "s3:GetMetricsConfiguration",
      "s3:PutMetricsConfiguration",
    ]
    resources = [local.arns.media_buckets]
  }

  # Tables, not their items (deploy_no_items, deploy_limits).
  statement {
    sid = "DynamoDB"
    actions = [
      "dynamodb:CreateTable",
      "dynamodb:UpdateTable",
      "dynamodb:DeleteTable",
      "dynamodb:Describe*",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:ListTagsOfResource",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
    ]
    resources = [local.arns.tables, "${local.arns.tables}/*"]
  }

  # Secrets and settings. Values are written through Terraform write-only
  # arguments, so they never land in state or plan files. GetParameter
  # stays: the AWS provider reads every parameter it manages, decrypted, on
  # each plan, write-only or not. It also reads older versions
  # ("name:version"), which no condition key can refuse
  # (docs/deployment.md, Replacing a generated secret).
  statement {
    sid = "Parameters"
    actions = [
      "ssm:PutParameter",
      "ssm:GetParameter",
      "ssm:DeleteParameter",
      "ssm:AddTagsToResource",
      "ssm:RemoveTagsFromResource",
      "ssm:ListTagsForResource",
    ]
    resources = [local.arns.parameters]
  }

  # Doesn't support resource-level permissions.
  statement {
    sid       = "ParametersDescribe"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  # The functions' log groups and the metric filters on them (../metrics.tf),
  # not what is in them (deploy_limits).
  statement {
    sid = "LogGroups"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:PutRetentionPolicy",
      "logs:DeleteRetentionPolicy",
      "logs:PutMetricFilter",
      "logs:DescribeMetricFilters",
      "logs:DeleteMetricFilter",
      "logs:ListTagsForResource",
      "logs:TagResource",
      "logs:UntagResource",
      # Older names of the same, which creating a tagged log group may need.
      "logs:ListTagsLogGroup",
      "logs:TagLogGroup",
      "logs:UntagLogGroup",
    ]
    resources = [local.arns.log_groups, "${local.arns.log_groups}:*"]
  }

  # Doesn't support resource-level permissions.
  statement {
    sid       = "LogsDescribe"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  # The WebSocket API. API IDs are random, so this can't be narrowed by name.
  statement {
    sid = "ApiGateway"
    actions = [
      "apigateway:GET",
      "apigateway:POST",
      "apigateway:PUT",
      "apigateway:PATCH",
      "apigateway:DELETE",
      "apigateway:TagResource",
      "apigateway:UntagResource",
    ]
    resources = [
      "${local.arns.apigateway}/apis",
      "${local.arns.apigateway}/apis/*",
      "${local.arns.apigateway}/tags/*",
    ]
  }
}

resource "aws_iam_policy" "deploy" {
  name        = "${local.prefix}-github-deploy"
  description = "Least-privilege permissions for deploying the Incognito Chat app stack (${var.github_environment})"
  policy      = data.aws_iam_policy_document.deploy.json

  # Changed only once the statements that moved out of it are attached in
  # their new policy, so a deploy is never without them.
  depends_on = [aws_iam_role_policy_attachment.deploy_functions]
}

# The functions: their code (built, signed and deployed), settings, URLs and
# permissions, and their roles' policies. A policy of its own, for room.
data "aws_iam_policy_document" "deploy_functions" {
  # Only the calls Terraform makes for the functions (../functions.tf,
  # ../edge.tf, ../websocket.tf), and reads.
  statement {
    sid = "Lambda"
    actions = [
      "lambda:Get*",
      "lambda:List*",
      "lambda:CreateFunction",
      "lambda:DeleteFunction",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
      "lambda:PutFunctionConcurrency",
      "lambda:DeleteFunctionConcurrency",
      "lambda:PutFunctionCodeSigningConfig",
      "lambda:PutFunctionEventInvokeConfig",
      "lambda:DeleteFunctionEventInvokeConfig",
      "lambda:CreateFunctionUrlConfig",
      "lambda:UpdateFunctionUrlConfig",
      "lambda:DeleteFunctionUrlConfig",
      "lambda:AddPermission",
      "lambda:RemovePermission",
      "lambda:TagResource",
      "lambda:UntagResource",
    ]
    resources = [local.arns.functions, "${local.arns.functions}:*"]
  }

  # The deploy invokes bot to set itself up and notify to check it starts
  # (deploy-environment.yml); no other function (deploy_limits).
  statement {
    sid     = "InvokeForChecks"
    actions = ["lambda:InvokeFunction"]
    # Unqualified and qualified: an invoke of the latest code is authorized
    # against the ARN with ":$LATEST" (InvokeOnlyChecks below).
    resources = flatten([for f in ["bot", "notify"] : [local.function_arns[f], "${local.function_arns[f]}:*"]])
  }

  # The functions' roles (function_roles.tf): read them, and write their
  # own policies, which the permissions boundary below caps. Nothing else:
  # the deploy role can't create a role or change whom one trusts.
  statement {
    sid = "FunctionRolesRead"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = values(local.function_role_arns)
  }

  statement {
    sid       = "FunctionRolePolicies"
    actions   = ["iam:PutRolePolicy", "iam:DeleteRolePolicy"]
    resources = values(local.function_role_arns)

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.lambda_boundary.arn]
    }
  }

  # The deploy asks IAM's policy simulator whether each function's role,
  # permissions boundary included, allows what it calls the others for, and
  # whether its own role still has the denies below
  # (scripts/check-function-roles.sh), before and after applying.
  statement {
    sid       = "CheckRoles"
    actions   = ["iam:SimulatePrincipalPolicy"]
    resources = concat(values(local.function_role_arns), [aws_iam_role.deploy.arn])
  }

  statement {
    sid       = "PassFunctionRolesToLambdaOnly"
    actions   = ["iam:PassRole"]
    resources = values(local.function_role_arns)

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  # Code signing (lambda_signing.tf): upload builds, have them signed, and
  # deploy the signed copies. Bucket settings, the profile and the code
  # signing config stay out of reach.
  statement {
    sid = "BuildsBucket"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:GetBucketLocation",
      "s3:GetBucketVersioning",
    ]
    resources = [aws_s3_bucket.builds.arn]
  }

  statement {
    sid = "Builds"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectTagging",
      "s3:GetObjectVersionTagging",
      "s3:PutObject",
      "s3:PutObjectTagging",
      # Terraform deletes every version of a removed build.
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.builds.arn}/*"]
  }

  statement {
    sid       = "SignBuilds"
    actions   = ["signer:StartSigningJob", "signer:GetSigningProfile"]
    resources = [aws_signer_signing_profile.lambda.arn]
  }

  statement {
    sid       = "SigningJobs"
    actions   = ["signer:DescribeSigningJob", "signer:GetRevocationStatus"]
    resources = ["arn:${local.partition}:signer:${local.region}:${local.account_id}:/signing-jobs/*"]
  }

  statement {
    sid       = "UseCodeSigningConfig"
    actions   = ["lambda:GetCodeSigningConfig", "lambda:PutFunctionCodeSigningConfig"]
    resources = [aws_lambda_code_signing_config.lambda.arn]
  }

  # Functions are created, and stay, with this code signing config only.
  statement {
    sid       = "KeepCodeSigningConfig"
    effect    = "Deny"
    actions   = ["lambda:CreateFunction", "lambda:PutFunctionCodeSigningConfig"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "lambda:CodeSigningConfigArn"
      values   = [aws_lambda_code_signing_config.lambda.arn]
    }
  }

  statement {
    sid       = "KeepCodeSigningAttached"
    effect    = "Deny"
    actions   = ["lambda:DeleteFunctionCodeSigningConfig"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "deploy_functions" {
  name        = "${local.prefix}-github-deploy-functions"
  description = "Permissions for deploying the Incognito Chat functions and their code (${var.github_environment})"
  policy      = data.aws_iam_policy_document.deploy_functions.json
}

resource "aws_iam_role_policy_attachment" "deploy_functions" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy_functions.arn
}

# The edge in front of the API: CloudFront and its firewall. A policy of its
# own, because one managed policy can't hold everything.
data "aws_iam_policy_document" "deploy_edge" {
  # CloudFront in front of the API. Distribution and access-control IDs are
  # random, so this can't be narrowed by name.
  statement {
    sid = "CloudFront"
    actions = [
      "cloudfront:CreateDistribution",
      "cloudfront:CreateDistributionWithTags",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "cloudfront:ListTagsForResource",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:GetOriginAccessControl",
      "cloudfront:GetOriginAccessControlConfig",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
    ]
    resources = [
      "arn:${local.partition}:cloudfront::${local.account_id}:distribution/*",
      "arn:${local.partition}:cloudfront::${local.account_id}:origin-access-control/*",
    ]
  }

  # AWS's managed cache and origin-request policies, looked up by name.
  statement {
    sid = "CloudFrontPolicies"
    actions = [
      "cloudfront:ListCachePolicies",
      "cloudfront:GetCachePolicy",
      "cloudfront:ListOriginRequestPolicies",
      "cloudfront:GetOriginRequestPolicy",
      "cloudfront:ListOriginAccessControls",
    ]
    resources = ["*"]
  }

  # The firewall in front of CloudFront: web ACLs named with the prefix
  # (they live in us-east-1, as CloudFront's do), and AWS's managed rules.
  statement {
    sid = "Firewall"
    actions = [
      "wafv2:CreateWebACL",
      "wafv2:GetWebACL",
      "wafv2:UpdateWebACL",
      "wafv2:DeleteWebACL",
      "wafv2:TagResource",
      "wafv2:UntagResource",
      "wafv2:ListTagsForResource",
    ]
    resources = [
      "arn:${local.partition}:wafv2:us-east-1:${local.account_id}:global/webacl/${local.prefix}-*/*",
      "arn:${local.partition}:wafv2:us-east-1:${local.account_id}:global/managedruleset/*/*",
    ]
  }
}

resource "aws_iam_policy" "deploy_edge" {
  name        = "${local.prefix}-github-deploy-edge"
  description = "Permissions for deploying CloudFront and its firewall in front of the Incognito Chat API (${var.github_environment})"
  policy      = data.aws_iam_policy_document.deploy_edge.json
}

resource "aws_iam_role_policy_attachment" "deploy_edge" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy_edge.arn
}

# Table items are runtime data: the app's, and the operator's settings, such
# as the emergency switches (S#switches) and the invitation levels. A deploy
# changes tables, never their items, so it can't overwrite a switch the
# operator set during an incident. A policy of its own, for room.
data "aws_iam_policy_document" "deploy_no_items" {
  statement {
    sid    = "NoTableItemWrites"
    effect = "Deny"
    actions = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:PartiQLInsert",
      "dynamodb:PartiQLUpdate",
      "dynamodb:PartiQLDelete",
    ]
    resources = [local.arns.tables]
  }
}

resource "aws_iam_policy" "deploy_no_items" {
  name        = "${local.prefix}-github-deploy-no-items"
  description = "Keeps deploys of the Incognito Chat app stack (${var.github_environment}) from writing table items"
  policy      = data.aws_iam_policy_document.deploy_no_items.json
}

resource "aws_iam_role_policy_attachment" "deploy_no_items" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy_no_items.arn
}

# What a deploy never needs, denied outright whatever the policies above
# allow: reading user data, and leaving access behind that no Terraform
# plan shows (a role trusted by another account, a function permission for
# one, a log subscription, a bucket notification). The app stack's
# Terraform never makes these calls. IAM's policy simulator
# checks that they are denied (scripts/check-function-roles.sh deploy-role),
# after each bootstrap and before each deploy.
data "aws_iam_policy_document" "deploy_limits" {
  # Items, streams, exports, backups and anything that copies a table or
  # shows its keys. Writes: deploy_no_items.
  statement {
    sid    = "NoTableData"
    effect = "Deny"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:ConditionCheckItem",
      "dynamodb:PartiQLSelect",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:Export*",
      "dynamodb:Import*",
      "dynamodb:CreateBackup",
      "dynamodb:Restore*",
      "dynamodb:PutResourcePolicy",
      "dynamodb:CreateTableReplica",
      "dynamodb:EnableKinesisStreamingDestination",
      "dynamodb:UpdateContributorInsights",
    ]
    resources = ["*"]
  }

  # Invoking runs a function with whatever event is sent: only the two the
  # deploy's checks invoke.
  statement {
    sid     = "InvokeOnlyChecks"
    effect  = "Deny"
    actions = ["lambda:InvokeFunction"]
    # Lambda authorizes an invoke of a function's latest code against the
    # ARN with ":$LATEST" (and a version or alias against its own), so each
    # name needs the qualified form too.
    not_resources = flatten([for f in ["bot", "notify"] : [local.function_arns[f], "${local.function_arns[f]}:*"]])
  }

  # Provisioned concurrency is billed every hour, used or not.
  statement {
    sid       = "NoOtherInvokesOrReservations"
    effect    = "Deny"
    actions   = ["lambda:InvokeAsync", "lambda:InvokeFunctionUrl", "lambda:PutProvisionedConcurrencyConfig"]
    resources = ["*"]
  }

  statement {
    sid           = "OnlyTheStackFunctions"
    effect        = "Deny"
    actions       = ["lambda:CreateFunction"]
    not_resources = values(local.function_arns)
  }

  statement {
    sid           = "UrlsForApiAndBotOnly"
    effect        = "Deny"
    actions       = ["lambda:CreateFunctionUrlConfig"]
    not_resources = [local.function_arns["api"], local.function_arns["bot"]]
  }

  # Whom a function's resource policy may name: anyone ("*") on api and bot
  # (their URLs), CloudFront on api, the WebSocket API on ws; no account or
  # role. IAM can't say more: AddPermission has no condition key for the
  # source ARN (so CloudFront or API Gateway in another account could be
  # named), nor for invoking only through the URL (so "*" could be let
  # invoke api or bot directly). The deploy reads the policies after
  # applying and fails on anything else (scripts/check-function-roles.sh
  # policies).
  statement {
    sid       = "PermissionsForTheStackOnly"
    effect    = "Deny"
    actions   = ["lambda:AddPermission"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "lambda:Principal"
      values   = ["*", "cloudfront.amazonaws.com", "apigateway.amazonaws.com"]
    }
  }

  statement {
    sid           = "PublicOnlyApiAndBot"
    effect        = "Deny"
    actions       = ["lambda:AddPermission"]
    not_resources = [local.function_arns["api"], local.function_arns["bot"]]

    condition {
      test     = "StringEquals"
      variable = "lambda:Principal"
      values   = ["*"]
    }
  }

  # "*" never for a URL that needs AWS's signature (api's, behind
  # CloudFront), which any AWS account's would then pass.
  statement {
    sid       = "PublicUrlsWithoutAuthOnly"
    effect    = "Deny"
    actions   = ["lambda:AddPermission"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "lambda:Principal"
      values   = ["*"]
    }

    condition {
      test     = "Null"
      variable = "lambda:FunctionUrlAuthType"
      values   = ["false"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "lambda:FunctionUrlAuthType"
      values   = ["NONE"]
    }
  }

  statement {
    sid           = "CloudFrontOnlyApi"
    effect        = "Deny"
    actions       = ["lambda:AddPermission"]
    not_resources = [local.function_arns["api"]]

    condition {
      test     = "StringEquals"
      variable = "lambda:Principal"
      values   = ["cloudfront.amazonaws.com"]
    }
  }

  statement {
    sid           = "ApiGatewayOnlyWs"
    effect        = "Deny"
    actions       = ["lambda:AddPermission"]
    not_resources = [local.function_arns["ws"]]

    condition {
      test     = "StringEquals"
      variable = "lambda:Principal"
      values   = ["apigateway.amazonaws.com"]
    }
  }

  # No new roles, users, keys or policy versions, no change to whom a role
  # trusts, and the boundary stays on the functions' roles.
  statement {
    sid    = "NoNewAccess"
    effect = "Deny"
    actions = [
      "iam:CreateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:AttachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
      "iam:CreateUser",
      "iam:CreateAccessKey",
      "iam:CreateLoginProfile",
      "iam:CreatePolicyVersion",
      "iam:SetDefaultPolicyVersion",
    ]
    resources = ["*"]
  }

  statement {
    sid           = "PoliciesOnFunctionRolesOnly"
    effect        = "Deny"
    actions       = ["iam:PutRolePolicy"]
    not_resources = values(local.function_role_arns)
  }

  # What the functions log, and copies of it elsewhere.
  statement {
    sid    = "NoLogReadsOrCopies"
    effect = "Deny"
    actions = [
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:GetLogRecord",
      "logs:StartQuery",
      "logs:StartLiveTail",
      "logs:Unmask",
      "logs:PutSubscriptionFilter",
      "logs:PutAccountPolicy",
      "logs:PutDestination*",
      "logs:CreateExportTask",
      "logs:CreateDelivery",
    ]
    resources = ["*"]
  }

  # Bucket settings the app stack doesn't manage, so no plan would show
  # them: versions (deleted attachments would stay), notices of each upload
  # and request logs elsewhere, copies and object lists elsewhere.
  statement {
    sid    = "NoBucketSideChannels"
    effect = "Deny"
    actions = [
      "s3:PutBucketVersioning",
      "s3:PutBucketObjectLockConfiguration",
      "s3:PutBucketNotification",
      "s3:PutBucketLogging",
      "s3:PutBucketWebsite",
      "s3:PutBucketAcl",
      "s3:PutReplicationConfiguration",
      "s3:PutInventoryConfiguration",
      "s3:PutAnalyticsConfiguration",
      "s3:PutAccountPublicAccessBlock",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "NoAttachments"
    effect    = "Deny"
    actions   = ["s3:GetObject*", "s3:PutObject*", "s3:DeleteObject*"]
    resources = ["${local.arns.media_buckets}/*"]
  }

  # Terraform reads each parameter (deploy policy). Not listing a
  # parameter's history, all parameters at once, or sharing them. This
  # doesn't keep older values from it: GetParameter takes "name:version" on
  # the same ARN, and no condition key refuses that.
  statement {
    sid       = "NoSecretHistoryOrSharing"
    effect    = "Deny"
    actions   = ["ssm:GetParameterHistory", "ssm:GetParametersByPath", "ssm:PutResourcePolicy"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "deploy_limits" {
  name        = "${local.prefix}-github-deploy-limits"
  description = "Keeps deploys of the Incognito Chat app stack (${var.github_environment}) from reading user data or leaving access behind"
  policy      = data.aws_iam_policy_document.deploy_limits.json
}

resource "aws_iam_role_policy_attachment" "deploy_limits" {
  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.deploy_limits.arn
}

# The most any function's execution role can ever be allowed to do. Each
# function gets a narrower policy of its own in the app stack.
data "aws_iam_policy_document" "lambda_boundary" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.arns.log_groups}:*"]
  }

  statement {
    sid = "DynamoDB"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [local.arns.tables, "${local.arns.tables}/index/*"]
  }

  statement {
    sid       = "Parameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [local.arns.parameters]
  }

  # Posting to sockets only (ws's push): GET @connections/{id} would return
  # a client's IP address, and nothing deletes connections.
  statement {
    sid       = "PushToSockets"
    actions   = ["execute-api:ManageConnections"]
    resources = [local.arns.ws_management]
  }

  # api invokes ws after each send (which pushes) and notify to seal chat
  # IDs; ws invokes notify for a notice. Each role allows only its own.
  statement {
    sid       = "InvokeFunctions"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.arns.notify, local.arns.ws]
  }

  # Encrypted attachments (presigned uploads and downloads, deletion).
  statement {
    sid       = "Media"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${local.arns.media_buckets}/*"]
  }
}

resource "aws_iam_policy" "lambda_boundary" {
  name        = "${local.prefix}-lambda-boundary"
  description = "Permissions boundary for every Incognito Chat function role (${var.github_environment})"
  policy      = data.aws_iam_policy_document.lambda_boundary.json
}
