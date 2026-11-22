#!/usr/bin/env bash
# One-time setup (rerun it to apply changes) of everything GitHub Actions
# needs to deploy:
#   - AWS: Terraform state bucket, GitHub OIDC provider, least-privilege deploy
#     role (checked afterwards with IAM's policy simulator), the functions'
#     roles and their permissions boundary, Lambda code signing (build
#     bucket, signing profile, code signing config), cost and health
#     alerts (a monthly budget, AWS's cost anomaly alerts, alarms, and the
#     topics they publish to, one in us-east-1 for CloudFront's and the
#     cost anomaly alerts), and the audit trail (CloudTrail),
#     change alerts and IAM Access Analyzer (infra/init)
#   - GitHub: a deployment environment that only accepts one branch (main) or
#     release tags, optionally with required reviewers, plus its secrets and
#     variables
#
# One AWS account per environment.
#
# Requirements: AWS admin credentials for the target account (for example
# AWS_PROFILE), gh authenticated as a repo admin, terraform >= 1.11, python3, jq.
# In the account, Cost Explorer turned on and no AWS services cost monitor
# but this stack's (checked before applying; docs/deployment.md, Setting up
# an environment).
#
# Usage: AWS_PROFILE=<profile> scripts/bootstrap.sh <aws-region> [github-environment]
#        DEPLOY_BRANCH=<branch> ... the only branch allowed to deploy (default: main).
#        DEPLOY_TAGS=<pattern> ... deploy from tags matching it instead, e.g. 'v*.*.*'
#                                  (production deploys published releases).
#        REVIEWERS=<login>[,<login>] ... GitHub users who must approve each deploy
#                                  (when unset, the environment keeps its current ones;
#                                  set but empty, none).
#        ALLOW_NO_REVIEWERS=1 ... lets REVIEWERS remove all of the environment's
#                                  required reviewers (refused otherwise).
#        MONTHLY_BUDGET=<dollars> ... the account's monthly cost budget
#                                  (default: 50 for production, 15 otherwise).
#        AUTO_APPROVE=1 ... skips Terraform's interactive approval.
#        GITHUB_REPO=<owner>/<repo> ... overrides the repo detected by gh.
#        STATS_REPO=<owner>/<repo> ... the website repository whose "stats" environment may read
#                                  this account's public statistics: a read-only role
#                                  (infra/init/stats_reader.tf) that reads costs, and in
#                                  production the counts too. The repository must send
#                                  immutable OIDC subjects; never an AWS Organization's
#                                  management account. Its environment is limited to main
#                                  first, then the role's ARN and region (and production's
#                                  counts namespace) are stored there. Without STATS_REPO,
#                                  a role made before is kept; STATS_REPO=none removes it.
#
# Nothing environment-specific is written to the repository: names are
# computed at runtime and stored as GitHub environment secrets and variables.
set -euo pipefail

region=${1:?usage: AWS_PROFILE=<profile> $0 <aws-region> [github-environment]}
environment=${2:-production}
deploy_branch=${DEPLOY_BRANCH:-main}
if [[ $environment == production ]]; then default_budget=50; else default_budget=15; fi
monthly_budget=${MONTHLY_BUDGET:-$default_budget}
environment_prefix="incognitochat-${environment}"
if [[ -n "${DEPLOY_TAGS:-}" ]]; then
  policy_type=tag policy_name=$DEPLOY_TAGS
else
  policy_type=branch policy_name=$deploy_branch
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
init_dir="$root/infra/init"

repo=${GITHUB_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
# The exact "sub" claim prefix GitHub puts in this repo's OIDC tokens. It
# differs when immutable subjects (owner/repo IDs) are enabled, e.g. after
# a rename, so ask GitHub instead of assuming a format.
oidc_subject_prefix=$(gh api "repos/${repo}/actions/oidc/customization/sub" --jq .sub_claim_prefix)
account_id=$(aws sts get-caller-identity --query Account --output text)
state_bucket="incognitochat-tfstate-${account_id}-${region}"

echo "Bootstrapping ${repo} (environment: ${environment}, deploys from ${policy_type} ${policy_name}) in AWS ${region}"

tf() { terraform -chdir="$init_dir" "$@"; }
backend_args=(-backend-config="bucket=${state_bucket}" -backend-config="region=${region}")
tf_vars=(
  -var "aws_region=${region}"
  -var "state_bucket_name=${state_bucket}"
  -var "github_oidc_subject_prefix=${oidc_subject_prefix}"
  -var "github_environment=${environment}"
  -var "monthly_budget_usd=${monthly_budget}"
)
apply_args=(-input=false "${tf_vars[@]}")

# The stats role (infra/init/stats_reader.tf): trusted only for STATS_REPO's
# "stats" environment, by the subject GitHub sends for it, which must be the
# immutable kind, with the owner's and the repository's IDs: a repository
# made again under the same name doesn't match. Without STATS_REPO, the
# subject from the last run is kept (stats_vars), so running this again for
# another reason doesn't remove the role; STATS_REPO=none removes it.
stats_repo=${STATS_REPO:-}
stats_subject=''
stats_metrics=false
[[ $environment == production ]] && stats_metrics=true
if [[ -n $stats_repo && $stats_repo != none ]]; then
  if [[ ! $stats_repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "STATS_REPO must be <owner>/<repo>, or none" >&2
    exit 1
  fi
  stats_prefix=$(gh api "repos/${stats_repo}/actions/oidc/customization/sub" --jq .sub_claim_prefix)
  if [[ ! $stats_prefix =~ ^repo:[A-Za-z0-9-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+$ ]]; then
    echo "${stats_repo} doesn't send immutable OIDC subjects (it sends ${stats_prefix}), so a" >&2
    echo "repository made again under its name could assume the stats role. Turn them on" >&2
    echo "(the repository's Actions OIDC settings) and rerun this." >&2
    exit 1
  fi
  stats_subject="${stats_prefix}:environment:stats"
  # Never the organization's management account: its Cost Explorer shows
  # every member account's costs.
  if org_admin=$(aws organizations describe-organization --query Organization.MasterAccountId --output text 2>&1); then
    if [[ $org_admin == "$account_id" ]]; then
      echo "This is the AWS Organization's management account: no stats role here." >&2
      exit 1
    fi
  elif [[ $org_admin != *AWSOrganizationsNotInUseException* ]]; then
    echo "Couldn't tell whether this is an AWS Organization's management account, so nothing" >&2
    echo "was applied. AWS said: ${org_admin}" >&2
    exit 1
  fi
fi

# Sets stats, the stats role's Terraform variables. After tf init.
stats_vars() {
  if [[ -z $stats_repo ]]; then
    stats_subject=$(tf output -raw stats_github_oidc_subject 2>/dev/null || true)
    [[ $stats_subject == *:environment:stats ]] || stats_subject=''
  fi
  stats=(-var "stats_github_oidc_subject=${stats_subject}" -var "stats_read_metrics=${stats_metrics}")
}

# STATS_REPO's "stats" environment: made, or kept with its protection
# settings, and limited to its main branch, before the role that trusts it
# exists. Fails on any error from GitHub.
stats_environment() {
  local current err body found=0 id type name policies
  err=$(mktemp)
  if current=$(gh api "repos/${stats_repo}/environments/stats" 2>"$err"); then
    rm -f "$err"
  elif grep -q 'HTTP 404' "$err"; then
    rm -f "$err"
    current='{}'
  else
    echo "Couldn't read ${stats_repo}'s 'stats' environment, so nothing was applied:" >&2
    cat "$err" >&2
    rm -f "$err"
    exit 1
  fi
  # The PUT replaces the protection settings: send back the current ones.
  # shellcheck disable=SC2016 # jq's own variables
  body=$(jq -c 'def rule: [.protection_rules[]? | select(.type == "required_reviewers")][0];
    {deployment_branch_policy: {protected_branches: false, custom_branch_policies: true},
     reviewers: [rule | .reviewers[]? | {type, id: .reviewer.id}]}
    + (if has("can_admins_bypass") then {can_admins_bypass} else {} end)
    + (rule // {} | if has("prevent_self_review") then {prevent_self_review} else {} end)
    + ([.protection_rules[]? | select(.type == "wait_timer") | {wait_timer}][0] // {})' <<<"$current")
  gh api --method PUT "repos/${stats_repo}/environments/stats" --input - <<<"$body" >/dev/null
  policies=$(gh api --paginate "repos/${stats_repo}/environments/stats/deployment-branch-policies" \
    --jq '.branch_policies[] | "\(.id) \(.type) \(.name)"')
  while read -r id type name; do
    [[ -z "$id" ]] && continue
    if [[ $type == branch && $name == main ]]; then
      found=1
    else
      gh api --method DELETE "repos/${stats_repo}/environments/stats/deployment-branch-policies/${id}" >/dev/null
    fi
  done <<<"$policies"
  if [[ $found == 0 ]]; then
    gh api --method POST "repos/${stats_repo}/environments/stats/deployment-branch-policies" \
      -f name=main -f type=branch >/dev/null
  fi
  echo "${stats_repo}'s 'stats' environment takes only main"
}
[[ "${AUTO_APPROVE:-}" == "1" ]] && apply_args+=(-auto-approve)

# The functions' roles that exist but aren't in this stack's state, as a
# JSON list: the app stack created them before they moved to infra/init
# (function_roles.tf), which imports them instead of creating them.
existing_function_roles() {
  local state fn out names=()
  state=$(tf state list 2>/dev/null || true)
  for fn in api bot ws notify; do
    grep -qxF "aws_iam_role.fn[\"${fn}\"]" <<<"$state" && continue
    if out=$(aws iam get-role --role-name "${environment_prefix}-fn-${fn}" --query Role.RoleName --output text 2>&1); then
      names+=("$fn")
    elif [[ $out != *NoSuchEntity* ]]; then
      echo "Couldn't check whether the ${fn} function's role exists: ${out}" >&2
      return 1
    fi
  done
  jq -cn '$ARGS.positional' --args "${names[@]}"
}

# The cost anomaly alerts (alerts.tf) need Cost Explorer, which only the
# console can turn on, and their monitor is the account's one AWS services
# monitor (DIMENSIONAL, SERVICE): AWS makes its own when Cost Explorer is
# turned on, and then creating this stack's fails. Check both before
# applying, so that a first run doesn't stop halfway.
check_cost_explorer() {
  local err out others
  err=$(mktemp)
  if ! out=$(aws ce get-anomaly-monitors --region us-east-1 --output json \
    --query "AnomalyMonitors[?MonitorType=='DIMENSIONAL' && MonitorDimension=='SERVICE'].MonitorName" 2>"$err"); then
    if grep -qi 'not enabled' "$err"; then
      echo "Cost Explorer isn't turned on in this account, and the cost anomaly alerts need it." >&2
      echo "Turn it on in the console (Billing and Cost Management, Cost Explorer, Launch Cost" >&2
      echo "Explorer; there is no API for it), delete the AWS services monitor AWS then makes, and" >&2
      echo "rerun this (docs/deployment.md, Setting up an environment). AWS said:" >&2
    else
      echo "Couldn't list the account's cost anomaly monitors, so nothing was applied. The cost" >&2
      echo "anomaly alerts need Cost Explorer turned on (docs/deployment.md, Setting up an" >&2
      echo "environment). AWS said:" >&2
    fi
    cat "$err" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  # shellcheck disable=SC2016 # jq's own variables
  others=$(jq -r --arg ours "${environment_prefix}-services" '.[] | select(. != $ours) | "  " + .' <<<"$out")
  if [[ -n $others ]]; then
    echo "The account already has an AWS services cost monitor, and may have only one:" >&2
    echo "$others" >&2
    echo "Delete it and its alert subscription first (Billing and Cost Management, Cost Anomaly" >&2
    echo "Detection; docs/deployment.md, Setting up an environment), then rerun this." >&2
    return 1
  fi
}

# --- AWS (Terraform) ----------------------------------------------------------
check_cost_explorer
if [[ -n $stats_repo && $stats_repo != none ]]; then
  stats_environment
fi
if aws s3api head-bucket --bucket "$state_bucket" --region "$region" 2>/dev/null; then
  tf init -input=false -reconfigure "${backend_args[@]}"
  roles=$(existing_function_roles)
  stats_vars
  tf apply "${apply_args[@]}" -var "existing_function_roles=${roles}" "${stats[@]}"
else
  # First run: the state bucket doesn't exist yet. Apply with local state,
  # then move that state into the bucket that was just created.
  echo "State bucket not found, so this is the first run: using local state until the bucket exists"
  override="$init_dir/backend_override.tf"
  trap 'rm -f "$override"' EXIT
  printf 'terraform {\n  backend "local" {}\n}\n' >"$override"
  tf init -input=false -reconfigure
  roles=$(existing_function_roles)
  stats_vars
  tf apply "${apply_args[@]}" -var "existing_function_roles=${roles}" "${stats[@]}"
  rm -f "$override"
  tf init -input=false -migrate-state -force-copy "${backend_args[@]}"
  rm -f "$init_dir/terraform.tfstate" "$init_dir/terraform.tfstate.backup"
fi

deploy_role_arn=$(tf output -raw deploy_role_arn)
builds_bucket=$(tf output -raw builds_bucket)
signing_profile=$(tf output -raw signing_profile_name)
code_signing_config=$(tf output -raw code_signing_config_arn)

# The deploy role must now be denied reading user data and leaving access
# behind, and be allowed what a deploy does with the functions. Each deploy
# checks the same before applying.
echo "Checking the deploy role's limits with IAM's policy simulator"
AWS_REGION=$region "$root/scripts/check-function-roles.sh" deploy-role "$deploy_role_arn" "$environment_prefix"

# --- GitHub -------------------------------------------------------------------
echo "Configuring GitHub environment '${environment}'"

# The PUT below replaces the environment's protection settings, so read them
# first. Only a 404 (a new environment) means it has none: on any other
# error, saving would drop production's required reviewers, so stop.
gh_error=$(mktemp)
if current=$(gh api "repos/${repo}/environments/${environment}" 2>"$gh_error"); then
  rm -f "$gh_error"
elif grep -q 'HTTP 404' "$gh_error"; then
  rm -f "$gh_error"
  current='{}'
  echo "The environment doesn't exist yet: creating it"
else
  echo "Couldn't read the GitHub environment '${environment}', so nothing was changed there:" >&2
  cat "$gh_error" >&2
  rm -f "$gh_error"
  exit 1
fi
# shellcheck disable=SC2016 # jq's own variables
rule='def rule: [.protection_rules[]? | select(.type == "required_reviewers")][0];'
has_reviewers=$(jq "$rule"' rule != null' <<<"$current")

# Required reviewers: as given (none if REVIEWERS is set but empty), or the
# current ones.
if [[ -n "${REVIEWERS+set}" ]]; then
  reviewers=$(for login in ${REVIEWERS//,/ }; do
    gh api "users/${login}" --jq '{type: "User", id: .id}' || exit 1
  done | jq -sc .)
else
  reviewers=$(jq -c "$rule"' [rule | .reviewers[]? | {type, id: .reviewer.id}]' <<<"$current")
fi
if [[ $reviewers == "[]" && $has_reviewers == true && "${ALLOW_NO_REVIEWERS:-}" != 1 ]]; then
  echo "The environment '${environment}' has required reviewers, and this would remove them." >&2
  echo "Set ALLOW_NO_REVIEWERS=1 if that is what you want." >&2
  exit 1
fi

# The other settings stay as they are (a new environment gets GitHub's
# defaults): whether whoever started a deploy may approve it, whether admins
# may skip the protection rules, and the wait before a deploy starts.
# shellcheck disable=SC2016 # jq's own variables
body=$(jq -c --argjson reviewers "$reviewers" "$rule"'
  {deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}, reviewers: $reviewers}
  + (if has("can_admins_bypass") then {can_admins_bypass} else {} end)
  + (rule // {} | if has("prevent_self_review") then {prevent_self_review} else {} end)
  + ([.protection_rules[]? | select(.type == "wait_timer") | {wait_timer}][0] // {})' <<<"$current")
gh api --method PUT "repos/${repo}/environments/${environment}" --input - <<<"$body" >/dev/null
echo "Required reviewers: $(jq length <<<"$reviewers")"
if [[ $reviewers == "[]" && $policy_type == tag ]]; then
  echo "Warning: deploys to '${environment}' need nobody's approval (set REVIEWERS)." >&2
fi

# Exactly one deployment policy: the branch, or the release tag pattern.
found=0
while read -r id type name; do
  [[ -z "$id" ]] && continue
  if [[ "$type" == "$policy_type" && "$name" == "$policy_name" ]]; then
    found=1
  else
    gh api --method DELETE "repos/${repo}/environments/${environment}/deployment-branch-policies/${id}" >/dev/null
    echo "Removed the deployment policy for ${type} ${name}"
  fi
done <<<"$(gh api "repos/${repo}/environments/${environment}/deployment-branch-policies" \
  --jq '.branch_policies[] | "\(.id) \(.type) \(.name)"')"
if [[ $found == 0 ]]; then
  gh api --method POST "repos/${repo}/environments/${environment}/deployment-branch-policies" \
    -f name="$policy_name" -f type="$policy_type" >/dev/null
fi

# Secrets (masked in public workflow logs); values are piped in so they don't
# appear in process arguments.
printf '%s' "$deploy_role_arn" | gh secret set AWS_ROLE_ARN --env "$environment" --repo "$repo"
printf '%s' "$account_id" | gh secret set AWS_ACCOUNT_ID --env "$environment" --repo "$repo"
printf '%s' "$state_bucket" | gh secret set TF_STATE_BUCKET --env "$environment" --repo "$repo"
printf '%s' "$builds_bucket" | gh secret set LAMBDA_BUILDS_BUCKET --env "$environment" --repo "$repo"
printf '%s' "$signing_profile" | gh secret set LAMBDA_SIGNING_PROFILE --env "$environment" --repo "$repo"
printf '%s' "$code_signing_config" | gh secret set LAMBDA_CODE_SIGNING_CONFIG --env "$environment" --repo "$repo"
gh variable set AWS_REGION --env "$environment" --repo "$repo" --body "$region"

# The stats role's ARN, region and (production) counts namespace, in
# STATS_REPO's "stats" environment, named for this account.
stats_role_arn=$(tf output -raw stats_role_arn 2>/dev/null || true)
if [[ -n $stats_repo && $stats_repo != none ]]; then
  if [[ $stats_role_arn != arn:* ]]; then
    echo "The stats role wasn't made, so ${stats_repo} wasn't given its ARN." >&2
    exit 1
  fi
  suffix=$(tr '[:lower:]' '[:upper:]' <<<"$environment")
  printf '%s' "$stats_role_arn" | gh secret set "STATS_ROLE_ARN_${suffix}" --env stats --repo "$stats_repo"
  gh variable set "STATS_REGION_${suffix}" --env stats --repo "$stats_repo" --body "$region"
  if [[ $stats_metrics == true ]]; then
    gh variable set "STATS_NAMESPACE_${suffix}" --env stats --repo "$stats_repo" --body "${environment_prefix}/api"
  fi
  echo "Stored the stats role for ${environment} in ${stats_repo}'s 'stats' environment"
elif [[ $stats_repo == none ]]; then
  echo "No stats role. Delete its secret and variables (STATS_*_${environment^^}) from the" \
    "website repository's 'stats' environment by hand if they're still there."
fi

if [[ $policy_type == tag ]]; then
  how_to_deploy="publish a release (merge the release pull request)"
else
  how_to_deploy="push to ${deploy_branch}"
fi
if ! gh secret list --env "$environment" --repo "$repo" --json name --jq '.[].name' | grep -qx BOT_TOKEN; then
  cat <<EOF

Done. One step left: store the Telegram bot token (from @BotFather) as an
environment secret. Run this yourself so the token never touches a file or
your shell history:

  gh secret set BOT_TOKEN --env ${environment} --repo ${repo}

Then deploy: ${how_to_deploy}.
EOF
else
  echo "Done. BOT_TOKEN is already set. To deploy: ${how_to_deploy}."
fi
echo "Budget, cost anomaly, alarm and change alerts go to the SNS topics ${environment_prefix}-alerts and, in us-east-1, ${environment_prefix}-edge-alerts; subscribe an address to each to receive them (docs/deployment.md)."
