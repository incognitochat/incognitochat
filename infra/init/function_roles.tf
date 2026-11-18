# The functions' execution roles. They are created here, by an admin, so the
# deploy role can't create a role, or change whom one trusts: Lambda alone
# may assume them. Each carries the permissions boundary
# (github_deploy.tf). The app stack writes each role's own policy
# ("runtime", ../functions.tf), and on these four roles alone the deploy
# role may write a policy.
data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fn" {
  for_each = local.functions

  name                 = "${local.prefix}-fn-${each.key}"
  description          = "Execution role of the ${each.key} function"
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = aws_iam_policy.lambda_boundary.arn

  # The app's, as when the app stack created them. An app stack from before
  # the move still manages them until it is deployed again, and so finds
  # nothing to change.
  tags = {
    Stack = "app"
  }
}

# The app stack created these roles before they moved here.
# scripts/bootstrap.sh lists those that exist and aren't in this state yet,
# and they are imported instead of created; the app stack then forgets them
# without deleting them (its removed block).
import {
  for_each = toset(var.existing_function_roles)

  to = aws_iam_role.fn[each.key]
  id = "${local.prefix}-fn-${each.key}"
}
