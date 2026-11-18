# App stack: the tables, settings, functions and WebSocket API of one
# environment. Applied by CI with the deploy role from infra/init, which only
# allows resources named "incognitochat-<environment>-…".

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "incognitochat"
      Environment = var.environment
      Stack       = "app"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id     = data.aws_caller_identity.current.account_id
  partition      = data.aws_partition.current.partition
  prefix         = "incognitochat-${var.environment}"
  parameter_path = "/incognitochat/${var.environment}"
}
