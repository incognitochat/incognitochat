output "deploy_role_arn" {
  description = "Role GitHub Actions assumes to deploy (stored as a GitHub environment secret)"
  value       = aws_iam_role.deploy.arn
}

output "deploy_policy_arn" {
  description = "Managed policy of the deploy role"
  value       = aws_iam_policy.deploy.arn
}

output "lambda_boundary_policy_arn" {
  description = "Permissions boundary the app stack must attach to every function role"
  value       = aws_iam_policy.lambda_boundary.arn
}

output "state_bucket_name" {
  description = "S3 bucket holding Terraform state"
  value       = aws_s3_bucket.state.bucket
}

output "builds_bucket" {
  description = "Versioned bucket CI uploads function builds to for signing (stored as a GitHub environment secret)"
  value       = aws_s3_bucket.builds.bucket
}

output "signing_profile_name" {
  description = "AWS Signer profile CI signs function builds with (stored as a GitHub environment secret)"
  value       = aws_signer_signing_profile.lambda.name
}

output "code_signing_config_arn" {
  description = "Code signing config every function must have (stored as a GitHub environment secret)"
  value       = aws_lambda_code_signing_config.lambda.arn
}

output "alerts_topic_arn" {
  description = "SNS topic the budget, the alarms, the change alerts of the app's region and Access Analyzer's findings publish to; subscribe an address to it to receive them"
  value       = aws_sns_topic.alerts.arn
}

output "edge_alerts_topic_arn" {
  description = "SNS topic in us-east-1 the alarms on CloudFront and its firewall, and the change alerts on IAM, CloudFront and the firewall, publish to; subscribe an address to it too"
  value       = aws_sns_topic.edge_alerts.arn
}

output "audit_trail_arn" {
  description = "The account's audit trail (CloudTrail), for checking its files (aws cloudtrail validate-logs)"
  value       = aws_cloudtrail.audit.arn
}

output "audit_bucket" {
  description = "Bucket holding the audit trail's files, for records older than CloudTrail's 90-day event history"
  value       = aws_s3_bucket.audit.bucket
}
