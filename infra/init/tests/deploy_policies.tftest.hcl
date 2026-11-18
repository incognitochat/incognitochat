# Renders the deploy role's policies with production's names (the longest)
# and checks that each fits in a managed policy, so that applying this stack
# can't stop halfway on one that doesn't, and that none of them allows a
# whole service again. Whether the denies hold in AWS is checked with IAM's
# policy simulator (scripts/check-function-roles.sh deploy-role) after each
# bootstrap and before each deploy. Nothing touches AWS: the provider has
# fake credentials and makes no calls (policy documents are rendered
# locally), and every resource the policies refer to is overridden, so
# "apply" creates nothing. Run by CI (terraform test).

provider "aws" {
  region                      = "eu-west-1"
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
  target = aws_s3_bucket.builds
  values = { arn = "arn:aws:s3:::incognitochat-production-builds-20251108161400000000000001" }
}

override_resource {
  target = aws_signer_signing_profile.lambda
  values = {
    arn         = "arn:aws:signer:eu-west-1:123456789012:/signing-profiles/incognitochat_production_lambda_20251108161400000000000001"
    version_arn = "arn:aws:signer:eu-west-1:123456789012:/signing-profiles/incognitochat_production_lambda_20251108161400000000000001/abcdefghij"
  }
}

override_resource {
  target = aws_lambda_code_signing_config.lambda
  values = { arn = "arn:aws:lambda:eu-west-1:123456789012:code-signing-config:csc-0123456789abcdef0" }
}

override_resource {
  target = aws_iam_policy.lambda_boundary
  values = { arn = "arn:aws:iam::123456789012:policy/incognitochat-production-lambda-boundary" }
}

override_resource {
  target = aws_iam_openid_connect_provider.github
  values = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
}

override_resource {
  target = aws_iam_role.deploy
  values = { arn = "arn:aws:iam::123456789012:role/incognitochat-production-github-deploy" }
}

run "deploy_policies" {
  # Policy documents are read only once the resources they name exist,
  # which here means overridden in an apply.
  command = apply

  plan_options {
    target = [
      data.aws_iam_policy_document.deploy,
      data.aws_iam_policy_document.deploy_functions,
      data.aws_iam_policy_document.deploy_edge,
      data.aws_iam_policy_document.deploy_no_items,
      data.aws_iam_policy_document.deploy_limits,
    ]
  }

  # IAM counts a managed policy's characters without whitespace.
  assert {
    condition = alltrue([
      for d in [
        data.aws_iam_policy_document.deploy,
        data.aws_iam_policy_document.deploy_functions,
        data.aws_iam_policy_document.deploy_edge,
        data.aws_iam_policy_document.deploy_no_items,
        data.aws_iam_policy_document.deploy_limits,
      ] : length(replace(d.json, "/\\s/", "")) <= 6144
    ])
    error_message = "A deploy policy is over IAM's 6,144 characters for a managed policy: move statements to another."
  }

  # Only the calls Terraform makes, not a whole service.
  assert {
    condition = alltrue([
      for d in [
        data.aws_iam_policy_document.deploy,
        data.aws_iam_policy_document.deploy_functions,
        data.aws_iam_policy_document.deploy_edge,
        ] : alltrue([
          for s in jsondecode(d.json).Statement : !anytrue([
            for a in flatten([try(s.Action, [])]) : endswith(a, ":*") || a == "*"
          ]) if s.Effect == "Allow"
      ])
    ])
    error_message = "A deploy policy allows every action of a service."
  }
}
