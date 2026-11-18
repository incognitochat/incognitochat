# Bootstrap stack: everything CI/CD needs before it can deploy the app stack
# (../). It's applied by an account admin via scripts/bootstrap.sh, never by CI,
# so the pipeline can't widen its own permissions. One AWS account per
# environment (dev, production).

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "incognitochat"
      Environment = var.github_environment
      Stack       = "bootstrap"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = var.aws_region

  # Every app resource is named "<prefix>-…". The deploy role may only touch
  # names with this prefix, so keep both stacks in sync (../main.tf).
  prefix = "incognitochat-${var.github_environment}"

  # SSM parameters live under this path.
  parameter_path = "/incognitochat/${var.github_environment}"

  # The monthly budget, unless one is given: the same whether this stack is
  # applied by scripts/bootstrap.sh or directly.
  monthly_budget_usd = coalesce(var.monthly_budget_usd, var.github_environment == "production" ? 50 : 15)

  # The app stack's functions (../functions.tf). Their roles are created
  # here (function_roles.tf), and the deploy role may create no others.
  functions = toset(["api", "bot", "ws", "notify"])

  function_arns = {
    for f in local.functions : f => "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.prefix}-${f}"
  }

  # Their roles' ARNs, from the names (function_roles.tf), so that the deploy
  # policies don't wait on roles that can never be destroyed.
  function_role_arns = {
    for f in local.functions : f => "arn:${local.partition}:iam::${local.account_id}:role/${local.prefix}-fn-${f}"
  }

  arns = {
    functions     = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.prefix}-*"
    notify        = local.function_arns["notify"]
    ws            = local.function_arns["ws"]
    tables        = "arn:${local.partition}:dynamodb:${local.region}:${local.account_id}:table/${local.prefix}-*"
    parameters    = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${local.parameter_path}/*"
    log_groups    = "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-*"
    apigateway    = "arn:${local.partition}:apigateway:${local.region}::"
    ws_management = "arn:${local.partition}:execute-api:${local.region}:${local.account_id}:*/*/POST/@connections/*"
    # From its name, as the bucket itself can never be destroyed (so the
    # policies' tests don't have to create it).
    state_bucket  = "arn:${local.partition}:s3:::${var.state_bucket_name}"
    media_buckets = "arn:${local.partition}:s3:::${local.prefix}-media-*"
  }
}
