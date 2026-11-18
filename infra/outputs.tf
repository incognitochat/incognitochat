# All outputs are sensitive so Terraform never prints them: workflow logs are
# public. CI reads them with `terraform output -raw` and masks them.
output "api_url" {
  description = "HTTPS API base URL (built into the client): CloudFront's, or the function URL while api_access is direct"
  value       = local.api_behind_cloudfront ? "https://${aws_cloudfront_distribution.api.domain_name}/" : aws_lambda_function_url.api.function_url
  sensitive   = true
}

output "api_function_url" {
  description = "The api function's own URL, behind CloudFront"
  value       = aws_lambda_function_url.api.function_url
  sensitive   = true
}

output "api_cloudfront_url" {
  description = "CloudFront's URL for the API, whatever api_access is (to try it before switching)"
  value       = "https://${aws_cloudfront_distribution.api.domain_name}/"
  sensitive   = true
}

output "api_locked" {
  description = "Whether the function URL answers CloudFront alone"
  value       = local.api_locked
}

output "ws_url" {
  description = "WebSocket URL (built into the client)"
  value       = "${aws_apigatewayv2_api.ws.api_endpoint}/${aws_apigatewayv2_stage.ws.name}"
  sensitive   = true
}

output "webhook_url" {
  description = "Telegram webhook URL"
  value       = aws_lambda_function_url.bot.function_url
  sensitive   = true
}

output "bot_function_name" {
  description = "The bot function, which the deploy invokes to register the webhook"
  value       = aws_lambda_function.fn["bot"].function_name
}

output "media_origin" {
  description = "The media bucket's origin (built into the client's security policy)"
  value       = "https://${aws_s3_bucket.media.bucket_regional_domain_name}"
  sensitive   = true
}

output "notify_function_name" {
  description = "The notify function, which the deploy invokes once to check it starts"
  value       = aws_lambda_function.fn["notify"].function_name
}

# The calls between functions that their roles must allow, permissions
# boundary (infra/init) included. A refused one only logs a warning, so the
# deploy checks them with IAM's policy simulator. ARNs name the account.
output "permission_checks" {
  description = "What each function's role must be allowed to do to the others, for the deploy to check"
  sensitive   = true
  value = {
    "api invokes ws (the push after each send)" = {
      role     = data.aws_iam_role.fn["api"].arn
      action   = "lambda:InvokeFunction"
      resource = aws_lambda_function.fn["ws"].arn
    }
    "api invokes notify (sealing chat IDs)" = {
      role     = data.aws_iam_role.fn["api"].arn
      action   = "lambda:InvokeFunction"
      resource = aws_lambda_function.fn["notify"].arn
    }
    "ws invokes notify (notices)" = {
      role     = data.aws_iam_role.fn["ws"].arn
      action   = "lambda:InvokeFunction"
      resource = aws_lambda_function.fn["notify"].arn
    }
    "ws posts to sockets" = {
      role     = data.aws_iam_role.fn["ws"].arn
      action   = "execute-api:ManageConnections"
      resource = "${aws_apigatewayv2_api.ws.execution_arn}/${aws_apigatewayv2_stage.ws.name}/POST/@connections/check"
    }
  }
}
