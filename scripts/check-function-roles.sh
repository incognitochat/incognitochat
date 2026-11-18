#!/usr/bin/env bash
# Checks with IAM's policy simulator that the functions' roles may make the
# calls the functions make to each other, and that the deploy role may not
# do what a deploy never needs (docs/deployment.md). A refused call only
# logs a warning in the function: sends would still succeed while pushes
# and notices stopped. So the deploy runs this three times:
#
#   boundary <function-prefix>
#       Before applying: whether the Lambda permissions boundary (infra/init,
#       applied by an admin) lets the existing roles invoke the functions
#       they need to. A policy allowing every invoke is added to the roles'
#       own (which deny nothing), so the answer depends on the boundary
#       alone, whatever the roles allow before this code is applied, and a
#       boundary older than this code stops the deploy before anything
#       changes. Roles that don't exist yet are skipped; the check after
#       applying covers them.
#   deploy-role <deploy-role-ARN> <function-prefix>
#       Before applying, and after each bootstrap (scripts/bootstrap.sh):
#       whether the deploy role is denied reading user data and leaving
#       access behind (infra/init, deploy_limits), and still allowed what
#       the deploy does with the functions. A deploy role older than this
#       code stops the deploy before anything changes.
#   roles
#       After applying: every call in the JSON on standard input (Terraform's
#       permission_checks output, at least 4), against each role's policy and
#       its boundary together.
#
# Role and function ARNs name the account: they are masked in GitHub
# Actions' logs and never printed, nor is anything the AWS CLI says beyond
# its error code. Needs the AWS CLI, jq, and credentials that may read the
# roles and run the simulator on them (the deploy role, infra/init, or an
# admin's).
set -euo pipefail

errors=$(mktemp)
trap 'rm -f "$errors"' EXIT

# mask hides a value in GitHub Actions' logs (elsewhere it does nothing).
mask() { if [[ ${GITHUB_ACTIONS:-} == true ]]; then echo "::add-mask::$1"; fi; }

# code prints the error code of the last failed AWS CLI call, if it gave one.
code() { grep -oE 'An error occurred \(([A-Za-z.]+)\)' "$errors" | head -n1 | sed -E 's/.*\((.*)\)/\1/' || true; }

# simulate <role ARN> <action> <resource ARN> [AWS CLI arguments...] prints
# the decision (allowed, implicitDeny or explicitDeny). The arguments can
# stand a policy in for the role's own (--policy-input-list) or set
# condition keys (--context-entries). Other errors than AccessDenied
# (throttling, the network) are tried again. It fails printing what went
# wrong: with 1 for AccessDenied, 2 for anything else.
simulate() {
  local args=(--policy-source-arn "$1" --action-names "$2" --resource-arns "$3"
    --query 'EvaluationResults[0].EvalDecision' --output text "${@:4}")
  local decision c
  for try in 1 2 3 4 5; do
    if decision=$(aws iam simulate-principal-policy "${args[@]}" 2>"$errors"); then
      echo "$decision"
      return 0
    fi
    c=$(code)
    if [[ $c == AccessDenied ]]; then
      echo "not checked: these credentials may not run the IAM policy simulator on this role (AccessDenied)"
      return 1
    fi
    ((try < 5)) && sleep $((try * 5))
  done
  echo "not checked: the IAM policy simulator failed (${c:-no error code})"
  return 2
}

# Set by check: whether a call wasn't decided as it should be (or the
# simulator may not be run), and whether one couldn't be checked for
# another reason.
refused=0
unavailable=0

# check <allowed|explicitDeny> <name> <role ARN> <action> <resource ARN>
# [AWS CLI arguments...] prints the outcome and notes it unless the call is
# decided as wanted. A role whose policies just changed may take a few
# seconds to show it, so a wrong decision is asked again, until one has
# been found for good.
check() {
  local want=$1 name=$2 decision status=0 tries=6
  shift 2
  ((refused)) && tries=1
  for ((try = 1; try <= tries; try++)); do
    decision=$(simulate "$@") || status=$?
    ((status == 0)) || break
    [[ $decision == "$want" ]] && break
    ((try < tries)) && sleep 10
  done
  if [[ $decision == "$want" ]]; then
    if [[ $want == allowed ]]; then echo "Allowed: ${name}"; else echo "Denied: ${name}"; fi
    return 0
  fi
  if [[ $want == allowed ]]; then
    echo "::error::Not allowed: ${name} (${decision})"
  else
    echo "::error::Not denied explicitly: ${name} (${decision})"
  fi
  if ((status == 2)); then unavailable=1; else refused=1; fi
}

# finish reports what was found and ends the check.
finish() {
  if ((refused)); then
    echo "::error::Apply infra/init in this environment (scripts/bootstrap.sh, docs/deployment.md): its permissions boundary or deploy role is older than this code."
  fi
  if ((unavailable)); then
    echo "::error::Some calls couldn't be checked: run the deploy again."
  fi
  if ((refused || unavailable)); then
    exit 1
  fi
  echo "$1"
}

# context <key> <type> <value> [<key> <type> <value>...] prints condition
# keys for simulate (--context-entries).
context() {
  jq -nc '[range(0; $ARGS.positional | length; 3) as $i | $ARGS.positional[$i:$i + 3]
    | {ContextKeyName: .[0], ContextKeyType: .[1], ContextKeyValues: [.[2]]}]' --args "$@"
}

case ${1:-} in
boundary)
  prefix=${2:?usage: $0 boundary <function-prefix>}
  allow_invokes='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"*"}]}'
  declare -A roles=()
  for caller in api ws; do
    if role=$(aws iam get-role --role-name "${prefix}-fn-${caller}" --query Role.Arn --output text 2>"$errors"); then
      mask "$role"
      roles[$caller]=$role
    elif [[ $(code) == NoSuchEntity ]]; then
      echo "No ${caller} role yet: its calls are checked after applying"
    else
      c=$(code)
      echo "::error::Couldn't read the ${caller} function's role (${c:-no error code})"
      if [[ $c == AccessDenied ]]; then refused=1; else unavailable=1; fi
    fi
  done
  checked=0
  for pair in "api ws" "api notify" "ws notify"; do
    read -r caller callee <<<"$pair"
    role=${roles[$caller]:-}
    [[ -n $role ]] || continue
    # The function's ARN, whether or not it exists yet: the role's account
    # and partition, the function's region and name.
    IFS=: read -r _ partition _ _ account _ <<<"$role"
    function="arn:${partition}:lambda:${AWS_REGION:?AWS_REGION is not set}:${account}:function:${prefix}-${callee}"
    mask "$function"
    check allowed "the boundary lets ${caller} invoke ${callee}" "$role" lambda:InvokeFunction "$function" \
      --policy-input-list "$allow_invokes"
    checked=$((checked + 1))
  done
  finish "Checked ${checked} calls against the permissions boundary"
  ;;
deploy-role)
  role=${2:?usage: $0 deploy-role <deploy-role-ARN> <function-prefix>}
  prefix=${3:?usage: $0 deploy-role <deploy-role-ARN> <function-prefix>}
  region=${AWS_REGION:?AWS_REGION is not set}
  # ARNs of the app stack's resources, whether or not they exist yet: the
  # role's account and partition, and their names (infra/main.tf).
  IFS=: read -r _ partition _ _ account _ <<<"$role"
  mask "$role"
  mask "$account"
  environment=${prefix#incognitochat-}
  fn() { echo "arn:${partition}:lambda:${region}:${account}:function:${prefix}-$1"; }
  fn_role="arn:${partition}:iam::${account}:role/${prefix}-fn"
  table="arn:${partition}:dynamodb:${region}:${account}:table/${prefix}"
  pepper="arn:${partition}:ssm:${region}:${account}:parameter/incognitochat/${environment}/telegram-id-pepper"
  log_group="arn:${partition}:logs:${region}:${account}:log-group:/aws/lambda/${prefix}-api"
  media="arn:${partition}:s3:::${prefix}-media-check"
  boundary="arn:${partition}:iam::${account}:policy/${prefix}-lambda-boundary"
  # An account that isn't this one (AWS's example account ID).
  outsider=111122223333

  # User data and secrets.
  check explicitDeny "reading a table item" "$role" dynamodb:GetItem "${table}-directory"
  check explicitDeny "scanning a table" "$role" dynamodb:Scan "${table}-directory"
  check explicitDeny "querying a table" "$role" dynamodb:Query "${table}-messages"
  check explicitDeny "writing a table item" "$role" dynamodb:PutItem "${table}-directory"
  check explicitDeny "exporting a table" "$role" dynamodb:ExportTableToPointInTime "${table}-directory"
  check explicitDeny "backing up a table" "$role" dynamodb:CreateBackup "${table}-directory"
  check explicitDeny "reading an attachment" "$role" s3:GetObject "${media}/m/check"
  check explicitDeny "reading logs" "$role" logs:FilterLogEvents "$log_group"
  check explicitDeny "reading a secret's older values (the pepper's)" "$role" ssm:GetParameterHistory "$pepper"
  check explicitDeny "invoking api" "$role" lambda:InvokeFunction "$(fn api)"
  check explicitDeny "invoking ws" "$role" lambda:InvokeFunction "$(fn ws)"

  # Access that would outlast the deploy, and no Terraform plan would show.
  check explicitDeny "giving a table a resource policy" "$role" dynamodb:PutResourcePolicy "${table}-directory"
  check explicitDeny "creating a role" "$role" iam:CreateRole "${fn_role}-check"
  check explicitDeny "changing whom a function's role trusts" "$role" iam:UpdateAssumeRolePolicy "${fn_role}-api"
  check explicitDeny "writing a policy on its own role" "$role" iam:PutRolePolicy "$role"
  check explicitDeny "attaching a policy to its own role" "$role" iam:AttachRolePolicy "$role"
  check explicitDeny "letting anyone call notify through a URL" "$role" lambda:AddPermission "$(fn notify)" \
    --context-entries "$(context lambda:Principal string '*' lambda:FunctionUrlAuthType string NONE)"
  check explicitDeny "letting anyone invoke api directly" "$role" lambda:AddPermission "$(fn api)" \
    --context-entries "$(context lambda:Principal string '*')"
  check explicitDeny "letting any AWS account call api's URL" "$role" lambda:AddPermission "$(fn api)" \
    --context-entries "$(context lambda:Principal string '*' lambda:FunctionUrlAuthType string AWS_IAM)"
  check explicitDeny "letting another account invoke api" "$role" lambda:AddPermission "$(fn api)" \
    --context-entries "$(context lambda:Principal string "$outsider")"
  check explicitDeny "creating another function" "$role" lambda:CreateFunction "$(fn check)"
  check explicitDeny "giving notify a URL" "$role" lambda:CreateFunctionUrlConfig "$(fn notify)"
  check explicitDeny "buying provisioned concurrency" "$role" lambda:PutProvisionedConcurrencyConfig "$(fn api):1"
  check explicitDeny "subscribing to a log group" "$role" logs:PutSubscriptionFilter "$log_group"
  check explicitDeny "keeping versions of attachments" "$role" s3:PutBucketVersioning "$media"
  check explicitDeny "getting notices of uploads" "$role" s3:PutBucketNotification "$media"

  # What the deploy does need, so the denies don't reach too far.
  check allowed "invoking bot (it sets itself up)" "$role" lambda:InvokeFunction "$(fn bot)"
  check allowed "invoking notify (its check)" "$role" lambda:InvokeFunction "$(fn notify)"
  check allowed "letting anyone call bot's URL" "$role" lambda:AddPermission "$(fn bot)" \
    --context-entries "$(context lambda:Principal string '*' lambda:FunctionUrlAuthType string NONE)"
  check allowed "letting bot's URL invoke it" "$role" lambda:AddPermission "$(fn bot)" \
    --context-entries "$(context lambda:Principal string '*' lambda:InvokedViaFunctionUrl boolean true)"
  check allowed "letting CloudFront invoke api" "$role" lambda:AddPermission "$(fn api)" \
    --context-entries "$(context lambda:Principal string cloudfront.amazonaws.com)"
  check allowed "letting the WebSocket API invoke ws" "$role" lambda:AddPermission "$(fn ws)" \
    --context-entries "$(context lambda:Principal string apigateway.amazonaws.com)"
  check allowed "writing a function role's policy" "$role" iam:PutRolePolicy "${fn_role}-api" \
    --context-entries "$(context iam:PermissionsBoundary string "$boundary")"
  finish "Checked the deploy role's limits"
  ;;
roles)
  checks=$(cat)
  if ! count=$(jq -e 'if type == "object" then length else error("not an object") end' <<<"$checks" 2>/dev/null) || ((count < 4)); then
    echo "::error::The permission checks to run are missing or malformed (Terraform output permission_checks)"
    exit 1
  fi
  arns=$(jq -er '.[] | .role, .resource' <<<"$checks")
  while read -r arn; do mask "$arn"; done <<<"$arns"
  names=$(jq -er 'keys[]' <<<"$checks")
  while read -r name; do
    role=$(jq -er --arg n "$name" '.[$n].role' <<<"$checks")
    action=$(jq -er --arg n "$name" '.[$n].action' <<<"$checks")
    resource=$(jq -er --arg n "$name" '.[$n].resource' <<<"$checks")
    check allowed "$name" "$role" "$action" "$resource"
  done <<<"$names"
  finish "Checked ${count} calls"
  ;;
*)
  echo "usage: $0 boundary <function-prefix> | deploy-role <deploy-role-ARN> <function-prefix> | roles < permission_checks.json" >&2
  exit 2
  ;;
esac
