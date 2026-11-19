#!/usr/bin/env bash
# Checks with IAM's policy simulator that the functions' roles may make the
# calls the functions make to each other, and that the deploy role may not
# do what a deploy never needs; and checks whom the functions' resource
# policies let invoke them (docs/deployment.md). A refused call only logs a
# warning in the function: sends would still succeed while pushes and
# notices stopped. So the deploy runs this four times:
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
#       whether the deploy role is denied reading user data, leaving
#       access behind and touching the audit trail (infra/init,
#       deploy_limits), and still allowed what the deploy does with the
#       functions and the edge. A deploy role
#       older than this code stops the deploy before anything changes.
#   roles
#       After applying: every call in the JSON on standard input (Terraform's
#       permission_checks output, at least 4), against each role's policy and
#       its boundary together.
#   policies <function-prefix>
#       After applying: each function's resource policy, which says who may
#       invoke it, must hold only the statements the app stack sets, as it
#       sets them, with CloudFront and API Gateway limited to the sources
#       in the JSON on standard input (Terraform's invoke_sources output),
#       and anyone only on bot, and on api while its URL needs no auth (not
#       api_locked). IAM can't keep the deploy role from adding others (another
#       account's distribution or API, or anyone without a URL), so a
#       deploy catches what an earlier one added. Prints statement IDs only.
#
# Role and function ARNs name the account: they are masked in GitHub
# Actions' logs and never printed, nor is anything the AWS CLI says beyond
# its error code. Needs the AWS CLI, jq, and credentials that may read the
# roles and the functions' policies and run the simulator on the roles (the
# deploy role, infra/init, or an admin's).
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
  request_policy="arn:${partition}:cloudfront::${account}:origin-request-policy/check"
  ip_set="arn:${partition}:wafv2:us-east-1:${account}:global/ipset/${prefix}-check/check"
  trail="arn:${partition}:cloudtrail:${region}:${account}:trail/${prefix}-audit"
  audit="arn:${partition}:s3:::${prefix}-audit-check"
  # An account that isn't this one (AWS's example account ID).
  outsider=111122223333

  # User data.
  check explicitDeny "reading a table item" "$role" dynamodb:GetItem "${table}-directory"
  check explicitDeny "scanning a table" "$role" dynamodb:Scan "${table}-directory"
  check explicitDeny "querying a table" "$role" dynamodb:Query "${table}-messages"
  check explicitDeny "writing a table item" "$role" dynamodb:PutItem "${table}-directory"
  check explicitDeny "exporting a table" "$role" dynamodb:ExportTableToPointInTime "${table}-directory"
  check explicitDeny "backing up a table" "$role" dynamodb:CreateBackup "${table}-directory"
  check explicitDeny "reading an attachment" "$role" s3:GetObject "${media}/m/check"
  check explicitDeny "reading logs" "$role" logs:FilterLogEvents "$log_group"
  check explicitDeny "listing a secret's history" "$role" ssm:GetParameterHistory "$pepper"
  check explicitDeny "invoking api" "$role" lambda:InvokeFunction "$(fn api):\$LATEST"
  check explicitDeny "invoking ws" "$role" lambda:InvokeFunction "$(fn ws)"

  # Access that would outlast the deploy, and no Terraform plan would show.
  check explicitDeny "giving a table a resource policy" "$role" dynamodb:PutResourcePolicy "${table}-directory"
  check explicitDeny "creating a role" "$role" iam:CreateRole "${fn_role}-check"
  check explicitDeny "changing whom a function's role trusts" "$role" iam:UpdateAssumeRolePolicy "${fn_role}-api"
  check explicitDeny "writing a policy on its own role" "$role" iam:PutRolePolicy "$role"
  check explicitDeny "attaching a policy to its own role" "$role" iam:AttachRolePolicy "$role"
  check explicitDeny "letting anyone call notify through a URL" "$role" lambda:AddPermission "$(fn notify)" \
    --context-entries "$(context lambda:Principal string '*' lambda:FunctionUrlAuthType string NONE)"
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

  # The audit trail, the record of what the deploy did (infra/init/audit.tf).
  check explicitDeny "stopping the audit trail" "$role" cloudtrail:StopLogging "$trail"
  check explicitDeny "creating another trail" "$role" cloudtrail:CreateTrail "${trail}-check"
  check explicitDeny "deleting the audit trail's records" "$role" s3:DeleteObject "${audit}/AWSLogs/check"
  check explicitDeny "changing the audit bucket's policy" "$role" s3:PutBucketPolicy "$audit"

  # What the deploy does need, so the denies don't reach too far, and
  # what Terraform calls through the narrowed allows.
  # As Lambda authorizes the deploy's invokes: against the latest code.
  check allowed "invoking bot (it sets itself up)" "$role" lambda:InvokeFunction "$(fn bot):\$LATEST"
  check allowed "invoking notify (its check)" "$role" lambda:InvokeFunction "$(fn notify):\$LATEST"
  check allowed "letting anyone call bot's URL" "$role" lambda:AddPermission "$(fn bot)" \
    --context-entries "$(context lambda:Principal string '*' lambda:FunctionUrlAuthType string NONE)"
  check allowed "letting bot's URL invoke it" "$role" lambda:AddPermission "$(fn bot)" \
    --context-entries "$(context lambda:Principal string '*')"
  check allowed "letting CloudFront invoke api" "$role" lambda:AddPermission "$(fn api)" \
    --context-entries "$(context lambda:Principal string cloudfront.amazonaws.com)"
  check allowed "letting the WebSocket API invoke ws" "$role" lambda:AddPermission "$(fn ws)" \
    --context-entries "$(context lambda:Principal string apigateway.amazonaws.com)"
  check allowed "reading a function's code signing config" "$role" lambda:GetFunctionCodeSigningConfig "$(fn api)"
  check allowed "writing a function role's policy" "$role" iam:PutRolePolicy "${fn_role}-api" \
    --context-entries "$(context iam:PermissionsBoundary string "$boundary")"
  check allowed "reading a table's backup settings" "$role" dynamodb:DescribeContinuousBackups "${table}-directory"
  check allowed "changing a table" "$role" dynamodb:UpdateTable "${table}-directory"
  check allowed "reading a log group's metric filters" "$role" logs:DescribeMetricFilters "$log_group"
  check allowed "setting the media bucket's policy" "$role" s3:PutBucketPolicy "$media"
  # The edge: CloudFront's origin request policy, and the firewall's IP sets
  # (in us-east-1) and its rules that use them.
  check allowed "creating an origin request policy" "$role" cloudfront:CreateOriginRequestPolicy "*"
  check allowed "changing an origin request policy" "$role" cloudfront:UpdateOriginRequestPolicy "$request_policy"
  check allowed "creating a firewall IP set" "$role" wafv2:CreateIPSet "$ip_set"
  check allowed "changing a firewall IP set" "$role" wafv2:UpdateIPSet "$ip_set"
  check allowed "letting the firewall's rules use an IP set" "$role" wafv2:UpdateWebACL "$ip_set"
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
policies)
  prefix=${2:?usage: $0 policies <function-prefix> < invoke_sources.json}
  sources=$(cat)
  if ! jq -e '(.cloudfront | type == "string") and (.websocket | type == "string") and (.api_locked | type == "boolean")' \
    <<<"$sources" >/dev/null 2>&1; then
    echo "::error::The invoke sources are missing or malformed (Terraform output invoke_sources)"
    exit 1
  fi
  while read -r arn; do mask "$arn"; done <<<"$(jq -r '.cloudfront, .websocket' <<<"$sources")"
  # Each statement the app stack sets (infra/functions.tf, edge.tf,
  # websocket.tf; the provider adds the FunctionURLAllow* pair itself when a
  # URL is made with no auth), on which functions, and what it must say.
  # Other conditions only narrow a statement, so they may be there too.
  # Anyone may call bot's URL, and api's until it answers CloudFront alone
  # (api_locked): the provider leaves its pair on api then, as a leftover.
  # shellcheck disable=SC2016 # jq's own variables
  expected='
    def anyone: .Principal == "*" or (.Principal | type == "object" and .AWS == "*");
    def service($s): .Principal | type == "object" and .Service == $s and length == 1;
    def cond($op; $key): [(.Condition[$op] // {}) | to_entries[]
      | select(.key | ascii_downcase == ($key | ascii_downcase)) | .value]
      | if length == 1 then .[0] | if type == "array" and length == 1 then .[0] else . end | tostring else null end;
    def public_url: anyone and .Action == "lambda:InvokeFunctionUrl"
      and cond("StringEquals"; "lambda:FunctionUrlAuthType") == "NONE";
    def through_url: anyone and .Action == "lambda:InvokeFunction"
      and cond("Bool"; "lambda:InvokedViaFunctionUrl") == "true";
    def from($s; $action; $arn): service($s) and .Action == $action and cond("ArnLike"; "AWS:SourceArn") == $arn;
    def open_url($f; $src): $f == "bot" or ($f == "api" and $src.api_locked == false);
    def as_set($f; $src):
      .Effect == "Allow" and (
        if open_url($f; $src) and (.Sid == "FunctionUrlPublic" or .Sid == "FunctionURLAllowPublicAccess") then public_url
        elif open_url($f; $src) and (.Sid == "FunctionUrlInvoke" or .Sid == "FunctionURLAllowInvokeAction") then through_url
        elif $f == "api" and .Sid == "CloudFrontUrl" then from("cloudfront.amazonaws.com"; "lambda:InvokeFunctionUrl"; $src.cloudfront)
        elif $f == "api" and .Sid == "CloudFrontInvoke" then from("cloudfront.amazonaws.com"; "lambda:InvokeFunction"; $src.cloudfront)
        elif $f == "ws" and .Sid == "WebSocketApi" then from("apigateway.amazonaws.com"; "lambda:InvokeFunction"; $src.websocket)
        else false end);
    [.Statement // [] | if type == "array" then .[] else . end
      | {sid: (.Sid // "(no ID)" | tostring), ok: as_set($f; $src),
         leftover: ($f == "api" and $src.api_locked
           and (.Sid == "FunctionURLAllowPublicAccess" or .Sid == "FunctionURLAllowInvokeAction"))}]'
  checked=0
  for f in api bot ws notify; do
    policy="" status=0
    for try in 1 2 3 4 5; do
      if policy=$(aws lambda get-policy --function-name "${prefix}-${f}" --query Policy --output text 2>"$errors"); then
        status=0
        break
      fi
      c=$(code)
      if [[ $c == ResourceNotFoundException ]]; then
        # No resource policy: nobody else may invoke it.
        policy='{"Statement":[]}' status=0
        break
      fi
      if [[ $c == AccessDenied* ]]; then
        status=1
        break
      fi
      status=2
      ((try < 5)) && sleep $((try * 5))
    done
    if ((status)); then
      echo "::error::Couldn't read the ${f} function's resource policy (${c:-no error code})"
      if ((status == 1)); then refused=1; else unavailable=1; fi
      continue
    fi
    if ! results=$(jq -c --arg f "$f" --argjson src "$sources" "$expected" <<<"$policy" 2>/dev/null); then
      echo "::error::The ${f} function's resource policy couldn't be read as a policy"
      unavailable=1
      continue
    fi
    good=$(jq -r '[.[] | select(.ok) | .sid] | sort | join(", ")' <<<"$results")
    echo "${f}: ${good:-no statements}"
    while IFS=$'\t' read -r leftover sid; do
      [[ -n $sid ]] || continue
      if [[ $leftover == true ]]; then
        echo "::error::The ${f} function's URL answers CloudFront alone, but its resource policy still lets anyone call it: ${sid}, which the AWS provider added while the URL needed no auth. Remove it as an admin: aws lambda remove-permission --function-name ${prefix}-${f} --statement-id ${sid} (docs/deployment.md, CloudFront in front of the API)"
        leftovers=1
      else
        echo "::error::The ${f} function's resource policy has a statement the app stack doesn't set, or not as it sets it: ${sid}"
        tampered=1
      fi
    done <<<"$(jq -r '.[] | select(.ok | not) | "\(.leftover)\t\(.sid)"' <<<"$results")"
    checked=$((checked + 1))
  done
  if ((${tampered:-0})); then
    echo "::error::Someone added to who may invoke the functions. Find out who (CloudTrail, lambda AddPermission), then remove it as an admin: aws lambda remove-permission --function-name <function> --statement-id <ID>."
  fi
  if ((${tampered:-0} || ${leftovers:-0})); then
    exit 1
  fi
  finish "Checked ${checked} functions' resource policies"
  ;;
*)
  echo "usage: $0 boundary <function-prefix> | deploy-role <deploy-role-ARN> <function-prefix> | roles < permission_checks.json | policies <function-prefix> < invoke_sources.json" >&2
  exit 2
  ;;
esac
