#!/usr/bin/env bash
# Checks that versions pinned in more than one place agree. Run by CI.
#
# - Each workflow that sets up Terraform pins TERRAFORM_VERSION itself, and
#   they must all be the same version, so the deploy applies with the CLI CI
#   validated and tested. A difference fails.
# - hosting/deploy.yml, the hosting repositories' workflow, is outside
#   .github/workflows, so Dependabot doesn't update its actions. Each action it
#   shares with .github/workflows should be pinned to the same commit there.
#   A difference only warns: the copies in the hosting repositories are
#   updated by hand (docs/development.md, Updating by hand).
# - The bot check's Python packages (scripts/verify-bot*.txt): each pinned to
#   one version with a sha256 hash. A missing one fails.
set -euo pipefail

cd "$(dirname "$0")/.."

status=0

# Terraform: one TERRAFORM_VERSION in each workflow that sets it up.
versions=
for workflow in .github/workflows/*.yml; do
  grep -q 'uses: hashicorp/setup-terraform@' "$workflow" || continue
  found=$(sed -nE 's/^ *TERRAFORM_VERSION: *"([0-9]+\.[0-9]+\.[0-9]+)" *$/\1/p' "$workflow")
  if [ "$(grep -c . <<<"$found")" != 1 ]; then
    echo "::error file=${workflow}::${workflow} sets up Terraform, so it must set TERRAFORM_VERSION: \"x.y.z\" once"
    status=1
  fi
  versions+="${found} ${workflow}"$'\n'
done
if [ "$(cut -d' ' -f1 <<<"$versions" | sed '/^$/d' | sort -u | wc -l)" -gt 1 ]; then
  echo "::error::The workflows pin different Terraform versions:"
  printf '%s' "$versions"
  status=1
elif [ "$status" = 0 ]; then
  echo "Terraform $(head -n 1 <<<"$versions" | cut -d' ' -f1) in: $(cut -d' ' -f2 <<<"$versions" | xargs)"
fi

# Actions: the action and commit of each `uses:` pinned to a full SHA.
pins() { sed -nE 's/^[ -]*uses: *([^@ ]+)@([0-9a-f]{40})( .*)?$/\1 \2/p' "$@"; }
hosting=hosting/deploy.yml
for line in $(grep -nE '^[ -]*uses:' "$hosting" | grep -vE '@[0-9a-f]{40}( |$)' | cut -d: -f1 || true); do
  echo "::warning file=${hosting},line=${line}::${hosting} uses an action that isn't pinned to a commit SHA"
done
while read -r action sha; do
  line=$(grep -nF "uses: ${action}@${sha}" "$hosting" | head -n 1 | cut -d: -f1)
  shared=$(pins .github/workflows/*.yml | awk -v a="$action" '$1 == a { print $2 }' | sort -u)
  if [ -z "$shared" ]; then
    echo "${action}: only ${hosting} uses it, so it's updated by hand"
  elif grep -qxF "$sha" <<<"$shared"; then
    echo "${action}: ${hosting} pins the same commit as .github/workflows"
  else
    echo "::warning file=${hosting},line=${line}::${hosting} pins ${action} at ${sha}, .github/workflows at $(xargs <<<"$shared"). Update it, then copy it into the hosting repositories (hosting/README.md)"
  fi
done < <(pins "$hosting" | sort -u)

# The bot check's Python packages: each pinned to one version and at least
# one sha256 hash, so `pip install --require-hashes` installs exactly what
# was reviewed (docs/verifying.md).
for req in scripts/verify-bot.build.txt scripts/verify-bot.requirements.txt; do
  bad=0
  # One requirement per line: comments dropped, continued lines joined.
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if ! [[ $entry =~ ^[A-Za-z0-9._-]+==[0-9][A-Za-z0-9.]*(\ --hash=sha256:[0-9a-f]{64})+$ ]]; then
      echo "::error file=${req}::${req} has a package not pinned to a version and a sha256 hash: ${entry%% *}"
      bad=1 status=1
    fi
  done < <(sed -e 's/#.*//' "$req" | sed -e ':a' -e '/\\$/{N;s/\\\n/ /;ba}' | tr -s ' \t' ' ' | sed -e 's/^ //; s/ $//')
  [ "$bad" = 1 ] || echo "${req}: every package pinned to a version and a hash"
done

exit "$status"
