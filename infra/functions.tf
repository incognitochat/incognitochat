# Four functions, one per trust boundary. Each has its own role, limited to
# its own tables, parameters and log group, inside the permissions boundary
# from infra/init. Only bot and notify can read the bot token. After a send,
# api invokes ws without waiting; only ws pushes to sockets, and invokes
# notify for a notice if no open app took the push. api invokes notify only
# to seal chat IDs.
locals {
  ws_endpoint = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
  # Built from names, not the functions' attributes, which would make the
  # functions depend on themselves.
  ws_arn     = "arn:${local.partition}:lambda:${var.aws_region}:${local.account_id}:function:${local.prefix}-ws"
  notify_arn = "arn:${local.partition}:lambda:${var.aws_region}:${local.account_id}:function:${local.prefix}-notify"

  functions = {
    # HTTPS API for the client.
    api = {
      timeout = 10
      # Measured on dev at 128 MB: most calls take ~20 ms waiting on DynamoDB,
      # but a batch of 20 send tokens (RSA signing, pure CPU) took ~4.5 s,
      # and ~2.2 s at 256 MB. That was before signing used CRT, about 1.9
      # times less CPU on arm64 (internal/tokens): measure again before
      # resizing. 256 MB doubles the CPU share; slow requests are logged
      # with their route and duration (internal/api) to size this from data.
      memory = 256
      # About 30 ms a request: room for roughly 3,000 requests a second.
      concurrency = 100
      tables      = ["directory", "messages", "ephemeral"]
      parameters = [
        "bot-id", "session-key", "telegram-id-pepper", "issuer-key", "media-issuer-key",
        "previous-issuer-key", "previous-media-issuer-key", "admin-telegram-ids",
      ]
      environment = {
        TABLE_DIRECTORY                 = aws_dynamodb_table.table["directory"].name
        TABLE_MESSAGES                  = aws_dynamodb_table.table["messages"].name
        TABLE_EPHEMERAL                 = aws_dynamodb_table.table["ephemeral"].name
        PARAM_BOT_ID                    = aws_ssm_parameter.parameter["bot-id"].name
        PARAM_SESSION_KEY               = aws_ssm_parameter.parameter["session-key"].name
        PARAM_TELEGRAM_ID_PEPPER        = aws_ssm_parameter.parameter["telegram-id-pepper"].name
        PARAM_ISSUER_KEY                = aws_ssm_parameter.parameter["issuer-key"].name
        PARAM_MEDIA_ISSUER_KEY          = aws_ssm_parameter.parameter["media-issuer-key"].name
        PARAM_PREVIOUS_ISSUER_KEY       = aws_ssm_parameter.parameter["previous-issuer-key"].name
        PARAM_PREVIOUS_MEDIA_ISSUER_KEY = aws_ssm_parameter.parameter["previous-media-issuer-key"].name
        PARAM_ADMIN_TELEGRAM_IDS        = aws_ssm_parameter.parameter["admin-telegram-ids"].name
        NOTIFY_FUNCTION                 = "${local.prefix}-notify"
        WS_FUNCTION                     = "${local.prefix}-ws"
        MEDIA_BUCKET                    = aws_s3_bucket.media.id
        INVITE_ONLY                     = tostring(var.invite_only)
      }
    }
    # Telegram webhook: opens the app, cleans up service messages. The deploy
    # invokes it once with a setup event to register the webhook.
    bot = {
      timeout     = 10
      concurrency = 5
      tables      = []
      parameters  = ["bot-token", "webhook-secret"]
      environment = {
        PARAM_BOT_TOKEN      = aws_ssm_parameter.parameter["bot-token"].name
        PARAM_WEBHOOK_SECRET = aws_ssm_parameter.parameter["webhook-secret"].name
        # The Mini App the bot's button opens: the client's origin.
        APP_URL = "${var.client_origins[0]}/"
      }
    }
    # WebSocket $connect and the heartbeat ($disconnect isn't routed), and
    # the push after each send, which api asks for without waiting. The
    # WebSocket stage's throttle bounds how often connects run; sends are
    # bounded by their tokens and caps. Twice notify's share: every send
    # comes here, and only those no open app took go on to notify. Connects
    # and pushes share it, so a flood of sends can hold up connects (refused
    # ones are tried again by the app, which polls meanwhile), and pushes
    # that wait over a minute are dropped (below). Its socket records in the
    # ephemeral table get their own, narrower statement below.
    ws = {
      timeout     = 5
      concurrency = 20
      tables      = []
      parameters  = ["session-key"]
      environment = {
        TABLE_EPHEMERAL   = aws_dynamodb_table.table["ephemeral"].name
        PARAM_SESSION_KEY = aws_ssm_parameter.parameter["session-key"].name
        NOTIFY_FUNCTION   = "${local.prefix}-notify"
        WS_ENDPOINT       = local.ws_endpoint
      }
    }
    # Generic "New message" notices through the bot. api invokes it to seal
    # chat IDs (POST /notices waits for that, sharing this concurrency with
    # notices), and ws without waiting after a delivery no open app took.
    # In the directory it reaches only account partitions, and in the
    # ephemeral table only its quiet periods: both get their own, narrower
    # statements below, and no table-wide one. The timeout must stay below
    # notices.Lease (30 s), the quiet period held while a notice is sent
    # (infra/tests checks it); it leaves room for one wait of up to 3 s when
    # Telegram's flood control asks for it.
    notify = {
      timeout     = 10
      concurrency = 10
      tables      = []
      parameters  = ["bot-token", "chat-key"]
      environment = {
        TABLE_DIRECTORY = aws_dynamodb_table.table["directory"].name
        TABLE_EPHEMERAL = aws_dynamodb_table.table["ephemeral"].name
        PARAM_BOT_TOKEN = aws_ssm_parameter.parameter["bot-token"].name
        PARAM_CHAT_KEY  = aws_ssm_parameter.parameter["chat-key"].name
        APP_URL         = "${var.client_origins[0]}/"
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each = local.functions

  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = var.log_retention_days
}

# Each function's role is created by infra/init (function_roles.tf),
# trusted by Lambda alone and capped by the permissions boundary, so the
# deploy role can't create roles or change whom they trust. This stack
# writes their policies. A new function needs its role there first.
data "aws_iam_role" "fn" {
  for_each = local.functions

  name = "${local.prefix}-fn-${each.key}"
}

# The roles were created here before they moved to infra/init, which
# imports them: forget them without deleting them.
removed {
  from = aws_iam_role.fn

  lifecycle {
    destroy = false
  }
}

data "aws_iam_policy_document" "fn" {
  for_each = local.functions

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.fn[each.key].arn}:*"]
  }

  dynamic "statement" {
    for_each = length(each.value.tables) > 0 ? [1] : []
    content {
      sid = "Tables"
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
      resources = [for t in each.value.tables : aws_dynamodb_table.table[t].arn]
    }
  }

  statement {
    sid       = "Parameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [for p in each.value.parameters : aws_ssm_parameter.parameter[p].arn]
  }

  # Only ws pushes, so whether the recipient's app is open never holds up
  # api's answer to a send. It only posts hints; it closes no connection.
  dynamic "statement" {
    for_each = each.key == "ws" ? [1] : []
    content {
      sid       = "PushToSockets"
      actions   = ["execute-api:ManageConnections"]
      resources = ["${aws_apigatewayv2_api.ws.execution_arn}/${aws_apigatewayv2_stage.ws.name}/POST/@connections/*"]
    }
  }

  # Socket records only (backend/internal/ephemeral, "C#" keys): ws records
  # them on connect, reads them to push and forgets closed ones. It can't
  # read rate counters, tokens or uploads.
  dynamic "statement" {
    for_each = each.key == "ws" ? [1] : []
    content {
      sid       = "SocketRecords"
      actions   = ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
      resources = [aws_dynamodb_table.table["ephemeral"].arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["C#*"]
      }
    }
  }

  # notify reads an account's notice settings (backend/internal/directory,
  # Notices): only in account partitions ("A#"; Null keeps out a request
  # without a partition key, such as a Scan), and only the key and the
  # sealed chat ID (cid), language (lg), last notice (nm) and "notices off"
  # (no). A read that names no attributes would return the whole item, so
  # it must name them (Select). IAM can't limit sort keys, nor an update's
  # ReturnValuesOnConditionCheckFailure, so this doesn't confine it to
  # account items or their notice fields: docs/security.md says what's left.
  # See
  # https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html
  # and https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazondynamodb.html
  # (which condition keys each action has).
  dynamic "statement" {
    for_each = each.key == "notify" ? [1] : []
    content {
      sid       = "ReadNoticeSettings"
      actions   = ["dynamodb:GetItem"]
      resources = [aws_dynamodb_table.table["directory"].arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["A#*"]
      }
      condition {
        test     = "Null"
        variable = "dynamodb:LeadingKeys"
        values   = ["false"]
      }
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "dynamodb:Attributes"
        values   = ["pk", "sk", "cid", "lg", "nm", "no"]
      }
      condition {
        test     = "StringEquals"
        variable = "dynamodb:Select"
        values   = ["SPECIFIC_ATTRIBUTES"]
      }
    }
  }

  # It writes the last notice (nm) and "notices off" (no) on account items,
  # with conditions on the key alone, and gets nothing back (NoticeSent,
  # NoticesOff). No PutItem or DeleteItem: they replace or remove whole
  # items. An update creates the item it names if it isn't there, so this
  # still lets it create items, holding only these fields, under any sort
  # key in an account partition.
  dynamic "statement" {
    for_each = each.key == "notify" ? [1] : []
    content {
      sid       = "RecordNotices"
      actions   = ["dynamodb:UpdateItem"]
      resources = [aws_dynamodb_table.table["directory"].arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["A#*"]
      }
      condition {
        test     = "Null"
        variable = "dynamodb:LeadingKeys"
        values   = ["false"]
      }
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "dynamodb:Attributes"
        values   = ["pk", "sk", "nm", "no"]
      }
      condition {
        test     = "StringEquals"
        variable = "dynamodb:ReturnValues"
        values   = ["NONE"]
      }
    }
  }

  # Quiet periods only (backend/internal/ephemeral, "Q#" keys).
  dynamic "statement" {
    for_each = each.key == "notify" ? [1] : []
    content {
      sid       = "QuietPeriods"
      actions   = ["dynamodb:PutItem"]
      resources = [aws_dynamodb_table.table["ephemeral"].arn]
      condition {
        test     = "ForAllValues:StringLike"
        variable = "dynamodb:LeadingKeys"
        values   = ["Q#*"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "api" ? [1] : []
    content {
      sid       = "Media"
      actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      resources = ["${aws_s3_bucket.media.arn}/m/*"]
    }
  }

  # api hands every send to ws, without waiting.
  dynamic "statement" {
    for_each = each.key == "api" ? [1] : []
    content {
      sid       = "InvokeWs"
      actions   = ["lambda:InvokeFunction"]
      resources = [local.ws_arn]
    }
  }

  # api asks notify to seal a chat ID (POST /notices), which only notify
  # holds the key for; it no longer asks for notices.
  dynamic "statement" {
    for_each = each.key == "api" ? [1] : []
    content {
      sid       = "SealChatIds"
      actions   = ["lambda:InvokeFunction"]
      resources = [local.notify_arn]
    }
  }

  # ws asks notify for a notice, without waiting, when no open app took a
  # push. notify has no access to sockets or their records.
  dynamic "statement" {
    for_each = each.key == "ws" ? [1] : []
    content {
      sid       = "InvokeNotify"
      actions   = ["lambda:InvokeFunction"]
      resources = [local.notify_arn]
    }
  }
}

resource "aws_iam_role_policy" "fn" {
  for_each = local.functions

  name   = "runtime"
  role   = data.aws_iam_role.fn[each.key].name
  policy = data.aws_iam_policy_document.fn[each.key].json
}

# Each build is uploaded, signed by AWS Signer, and the signed copy is
# deployed. The code signing config (infra/init) makes Lambda refuse code
# that isn't signed by CI's profile. A new upload happens only when a build
# changes, and each upload gets a new signing job and a new signed copy.
resource "aws_s3_object" "build" {
  for_each = local.functions

  bucket      = var.lambda_builds_bucket
  key         = "builds/${each.key}.zip"
  source      = "${var.lambda_dir}/${each.key}.zip"
  source_hash = filesha256("${var.lambda_dir}/${each.key}.zip")
}

resource "aws_signer_signing_job" "build" {
  for_each = local.functions

  profile_name = var.lambda_signing_profile

  source {
    s3 {
      bucket  = aws_s3_object.build[each.key].bucket
      key     = aws_s3_object.build[each.key].key
      version = aws_s3_object.build[each.key].version_id
    }
  }

  destination {
    s3 {
      bucket = var.lambda_builds_bucket
      prefix = "signed/${each.key}/"
    }
  }
}

resource "aws_lambda_function" "fn" {
  for_each = local.functions

  function_name           = "${local.prefix}-${each.key}"
  description             = "Incognito Chat ${each.key} (${var.environment})"
  role                    = data.aws_iam_role.fn[each.key].arn
  runtime                 = "provided.al2023"
  handler                 = "bootstrap"
  architectures           = ["arm64"]
  memory_size             = lookup(each.value, "memory", 128)
  timeout                 = each.value.timeout
  s3_bucket               = aws_signer_signing_job.build[each.key].signed_object[0].s3[0].bucket
  s3_key                  = aws_signer_signing_job.build[each.key].signed_object[0].s3[0].key
  code_signing_config_arn = var.lambda_code_signing_config_arn

  # A reservation is the function's guaranteed share of the account's
  # concurrent executions and also its ceiling: a flood on one function
  # can't starve the others, and its worst-case cost is bounded. -1 leaves
  # the function unreserved.
  reserved_concurrent_executions = var.reserve_concurrency ? each.value.concurrency : -1

  # Functions read their parameters once, at cold start. PARAMS_VERSION
  # changes whenever one of this function's parameters is rewritten, which
  # updates the function and so replaces its warm instances.
  environment {
    variables = merge(
      {
        ENVIRONMENT    = var.environment
        PARAMS_VERSION = join(",", [for p in each.value.parameters : "${p}=${local.parameter_versions[p]}"])
      },
      each.value.environment,
    )
  }

  # JSON at warning level; the platform's START/END/REPORT lines are dropped
  # too. The code logs only allow-listed fields (backend/internal/logx).
  logging_config {
    log_format            = "JSON"
    application_log_level = "WARN"
    system_log_level      = "WARN"
    log_group             = aws_cloudwatch_log_group.fn[each.key].name
  }

  # New instances must read the new parameter values.
  depends_on = [aws_iam_role_policy.fn, aws_ssm_parameter.parameter]
}

# Notices are sent at once or not at all: a late notice is little use, and
# a retry after Telegram's flood control refused one would only add to the
# flood. Instead (backend/internal/notices), a notice refused outright
# ends its quiet period, so the next message can notify; one refused by
# flood control keeps the account quiet for as long as Telegram asked (at
# least a minute), and the instance sends none until then.
resource "aws_lambda_function_event_invoke_config" "notify" {
  function_name                = aws_lambda_function.fn["notify"].function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}

# The push after a send, too: tried once, or not at all if it waited a
# minute for room to run (an open app also polls, every two minutes). A
# retry would only push the hint again, and ask for the notice again (which
# notify's quiet period would mostly drop). The hint carries nothing, so
# the rare event Lambda delivers twice is harmless. The function logs its
# failures rather than returning them.
resource "aws_lambda_function_event_invoke_config" "ws" {
  function_name                = aws_lambda_function.fn["ws"].function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}

# HTTPS endpoints. The functions authenticate requests themselves: session
# tokens for api, the webhook secret header for bot. The api URL is public
# until the API is moved behind CloudFront alone (edge.tf), when it requires
# AWS's signature, which only CloudFront adds.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.fn["api"].function_name
  authorization_type = local.api_locked ? "AWS_IAM" : "NONE"

  cors {
    allow_origins = var.client_origins
    allow_methods = ["GET", "POST", "PUT", "DELETE"]
    # x-session carries the session token (never authorization, which the
    # app doesn't send: CloudFront's signature goes there, between it and
    # this URL, which CORS doesn't cover); x-amz-content-sha256 is the
    # body's hash, which Lambda needs once CloudFront signs requests to
    # this URL.
    allow_headers = ["content-type", "x-amz-content-sha256", "x-device-signature", "x-session"]
    # So the app can read how long to wait after 503 unavailable or
    # daily_limit, and say when a link_busy or download_limit refusal
    # ends; a browser hides other headers from a page on another origin.
    expose_headers = ["retry-after"]
    max_age        = 3600
  }
}

resource "aws_lambda_function_url" "bot" {
  function_name      = aws_lambda_function.fn["bot"].function_name
  authorization_type = "NONE"
}

# A public function URL needs both permissions: one for the URL, and one for
# the invocation behind it (limited to calls through the URL).
locals {
  public_functions = toset(local.api_locked ? ["bot"] : ["api", "bot"])
}

resource "aws_lambda_permission" "url" {
  for_each = local.public_functions

  statement_id           = "FunctionUrlPublic"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.fn[each.key].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  for_each = local.public_functions

  statement_id             = "FunctionUrlInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.fn[each.key].function_name
  principal                = "*"
  invoked_via_function_url = true
}
