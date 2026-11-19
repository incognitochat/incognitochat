#!/usr/bin/env bash
# Checks that the deploy passes each version variable of infra/variables.tf
# (<name>_version) from the GitHub variable of the same name in upper case,
# 1 while unset, exactly once, in this form:
#
#   TF_VAR_<name>_version: ${{ vars.<NAME>_VERSION || '1' }}
#
# and passes no other version. A version decides when a secret is written
# again (infra/parameters.tf), and Terraform's tests can't see the workflow:
# a swapped or misspelled line would pass them, and the deploy would then
# replace the wrong secret, or none. Run by CI.
set -euo pipefail

cd "$(dirname "$0")/.."
workflow=.github/workflows/deploy-environment.yml

declared=$(sed -nE 's/^variable "([a-z0-9_]+_version)" \{$/\1/p' infra/variables.tf | sort)
passed=$(sed -nE 's/^ *TF_VAR_([a-z0-9_]+_version):.*/\1/p' "$workflow" | sort)

if [ -z "$declared" ]; then
  echo "::error::No version variables found in infra/variables.tf"
  exit 1
fi

status=0
if [ "$declared" != "$passed" ]; then
  echo "::error::$workflow doesn't pass the versions infra/variables.tf declares, each once (< declared, > passed):"
  diff <(echo "$declared") <(echo "$passed") || true
  status=1
fi
for name in $declared; do
  want="TF_VAR_${name}: \${{ vars.${name^^} || '1' }}"
  if ! sed -E 's/^ +//' "$workflow" | grep -qxF "$want"; then
    echo "::error::$workflow must pass $name as: $want"
    status=1
  fi
done
if [ "$status" = 0 ]; then
  echo "Each version reaches Terraform from its own variable: $(echo "$declared" | tr '\n' ' ')"
fi
exit "$status"
