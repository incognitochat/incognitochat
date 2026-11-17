#!/usr/bin/env bash
# Checks with IAM's policy simulator that the functions' roles may make the
# calls the functions make to each other (docs/deployment.md). A refused
# call only logs a warning in the function: sends would still succeed while
# pushes and notices stopped. So the deploy runs this twice:
#
#   boundary <function-prefix>
#       Before applying: whether the Lambda permissions boundary (infra/init,
#       applied by an admin) lets the existing roles invoke the functions
#       they need to. A policy allowing every invoke is added to the roles'
#       own (which deny nothing), so the answer depends on the boundary
#       alone, whatever the roles allow before this code is applied, and a
#       boundary older than this code stops the deploy before anything
#       changes. Roles that don't exist yet (a first deploy) are skipped;
#       the check after applying covers them.
#   roles
#       After applying: every call in the JSON on standard input (Terraform's
#       permission_checks output, at least 4), against each role's policy and
#       its boundary together.
#
# Role and function ARNs name the account: they are masked in GitHub
# Actions' logs and never printed, nor is anything the AWS CLI says beyond
# its error code. Needs the AWS CLI, jq, and credentials that may read the
# roles and run the simulator on them (the deploy role, infra/init).
set -euo pipefail

errors=$(mktemp)
trap 'rm -f "$errors"' EXIT

mask() { echo "::add-mask::$1"; }

# code prints the error code of the last failed AWS CLI call, if it gave one.
code() { grep -oE 'An error occurred \(([A-Za-z.]+)\)' "$errors" | head -n1 | sed -E 's/.*\((.*)\)/\1/' || true; }

# simulate <role ARN> <action> <resource ARN> [policy JSON] prints the
# decision (allowed, implicitDeny or explicitDeny). With a policy, it stands
# in for the role's own. Other errors than AccessDenied (throttling, the
# network) are tried again. It fails printing what went wrong: with 1 for
# AccessDenied, 2 for anything else.
simulate() {
  local args=(--policy-source-arn "$1" --action-names "$2" --resource-arns "$3"
    --query 'EvaluationResults[0].EvalDecision' --output text)
  [[ -n ${4:-} ]] && args+=(--policy-input-list "$4")
  local decision c
  for try in 1 2 3 4 5; do
    if decision=$(aws iam simulate-principal-policy "${args[@]}" 2>"$errors"); then
      echo "$decision"
      return 0
    fi
    c=$(code)
    if [[ $c == AccessDenied ]]; then
      echo "not checked: the deploy role may not run the IAM policy simulator (AccessDenied)"
      return 1
    fi
    ((try < 5)) && sleep $((try * 5))
  done
  echo "not checked: the IAM policy simulator failed (${c:-no error code})"
  return 2
}

# Set by check: whether a call was refused (or the simulator may not be
# run), and whether one couldn't be checked for another reason.
refused=0
unavailable=0

# check <name> <role ARN> <action> <resource ARN> [policy JSON] prints the
# outcome and notes it unless the call is allowed. A role whose policy just
# changed may take a few seconds to show it, so a refusal is asked again.
check() {
  local name=$1 decision status=0
  shift
  for try in 1 2 3 4 5 6; do
    decision=$(simulate "$@") || status=$?
    ((status == 0)) || break
    [[ $decision == allowed ]] && break
    ((try < 6)) && sleep 10
  done
  if [[ $decision == allowed ]]; then
    echo "Allowed: ${name}"
    return 0
  fi
  echo "::error::Not allowed: ${name} (${decision})"
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
      echo "No ${caller} role yet (a first deploy): its calls are checked after applying"
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
    check "the boundary lets ${caller} invoke ${callee}" "$role" lambda:InvokeFunction "$function" "$allow_invokes"
    checked=$((checked + 1))
  done
  finish "Checked ${checked} calls against the permissions boundary"
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
    check "$name" "$role" "$action" "$resource"
  done <<<"$names"
  finish "Checked ${count} calls"
  ;;
*)
  echo "usage: $0 boundary <function-prefix> | roles < permission_checks.json" >&2
  exit 2
  ;;
esac
