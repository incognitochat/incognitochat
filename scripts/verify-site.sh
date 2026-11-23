#!/usr/bin/env bash
# Checks that a live site is exactly what a reviewed copy of the hosting
# workflow built from this repository's main branch, and optionally that
# rebuilding the same commit gives the same bytes (docs/verifying.md).
#
#   scripts/verify-site.sh <site URL> <hosting repository> [--rebuild] [--code-repo <owner>/<repo>]
#   scripts/verify-site.sh https://<org>.github.io <org>/<org>.github.io --rebuild
#
# Everything the site serves is untrusted until checked, the manifest's paths,
# repository and commit included. The code repository the site must be built
# from is this checkout's origin on GitHub, or --code-repo. What it checks is
# listed in docs/verifying.md.
#
# Needs curl, jq, sha256sum, git and the GitHub CLI 2.93.0 or later (2.102.0
# or later recommended), logged in (gh auth login, any account: it only reads
# public data). --rebuild also needs the Node the manifest says built the site
# (web/.nvmrc at the site's commit); with another one it stops before building.
#
# Exit codes: 0 verified, 1 verification failed, 2 usage or setup error.
set -euo pipefail
# Character classes below mean ASCII only; the rebuild gets the caller's locale.
caller_lc_all=${LC_ALL-} caller_lc_all_set=${LC_ALL+1}
export LC_ALL=C

die() { echo "Error: $*" >&2; exit 2; }
refuse() { echo "$*"; echo "VERIFICATION FAILED"; exit 1; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

site='' hosting='' code_repo='' rebuild=0
while [ $# -gt 0 ]; do
  case $1 in
    --rebuild) rebuild=1 ;;
    --code-repo) [ $# -ge 2 ] || die "--code-repo needs <owner>/<repo>"; code_repo=$2; shift ;;
    --code-repo=*) code_repo=${1#*=} ;;
    -*) die "unknown option $1" ;;
    *)
      if [ -z "$site" ]; then site=$1
      elif [ -z "$hosting" ]; then hosting=$1
      else die "unexpected argument $1"
      fi ;;
  esac
  shift
done
[ -n "$site" ] && [ -n "$hosting" ] \
  || die "usage: $0 <site URL> <hosting repository> [--rebuild] [--code-repo <owner>/<repo>]"

tools=(curl jq sha256sum git gh)
[ "$rebuild" = 0 ] || tools+=(node npm)
for tool in "${tools[@]}"; do
  command -v "$tool" >/dev/null || die "$tool is missing"
done
# --signer-digest and --source-ref came in gh 2.68.0 (cli/cli#10308).
gh attestation verify --help 2>/dev/null | grep -q -- --signer-digest \
  || die "this GitHub CLI can't pin the signing workflow (no --signer-digest); update it"
# Before 2.93.0, gh attestation sent the login token to the TUF mirror's host
# (GHSA-8xvp-7hj6-mcj9). Before 2.102.0, --signer-workflow matched a prefix
# and --source-ref ignored case; the exact --cert-identity below covers both.
older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }
ghv=$(gh --version | sed -n '1s/^gh version \([0-9][0-9.]*\).*/\1/p')
if [ -n "$ghv" ] && older "$ghv" 2.93.0; then
  die "gh ${ghv} would send your GitHub token to the TUF mirror (GHSA-8xvp-7hj6-mcj9); update to 2.102.0 or later"
elif [ -n "$ghv" ] && older "$ghv" 2.102.0; then
  echo "Note: gh ${ghv} is older than 2.102.0, the version these checks are written for; consider updating" >&2
fi
gh auth status >/dev/null 2>&1 \
  || die "the GitHub CLI needs a login (gh auth login, any account) to read public attestations"

repo_re='^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'
# A plain relative path: no empty, "." or ".." segment, no leading "/".
path_re='^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
branch=main # the code repository's release branch, and the hosting repository's
export GIT_TERMINAL_PROMPT=0

# The code repository: this checkout's origin, unless named.
if [ -z "$code_repo" ]; then
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  url=$(git -C "$root" remote get-url origin 2>/dev/null) \
    || die "can't read this checkout's origin; name the code repository with --code-repo <owner>/<repo>"
  case $url in
    git@github.com:*) code_repo=${url#git@github.com:} ;;
    ssh://git@github.com/*) code_repo=${url#ssh://git@github.com/} ;;
    https://github.com/*) code_repo=${url#https://github.com/} ;;
    *) die "this checkout's origin isn't on GitHub; name the code repository with --code-repo <owner>/<repo>" ;;
  esac
  code_repo=${code_repo%/}
  code_repo=${code_repo%.git}
fi
[[ $code_repo =~ $repo_re ]] || die "the code repository must be <owner>/<repo>"
[[ $hosting =~ $repo_re ]] || die "the hosting repository must be <org>/<org>.github.io"

# The app lives at the root of its organization's own Pages address: the
# origin whose browser storage holds the keys.
site=${site%/}
org=${hosting%%/*}
if [ "$(lower "$hosting")" != "$(lower "${org}/${org}.github.io")" ] \
  || [ "$(lower "$site")" != "$(lower "https://${org}.github.io")" ]; then
  die "expected https://<org>.github.io and <org>/<org>.github.io: the app is served at the root of its organization's Pages address"
fi
# GitHub's own spelling of the names, which the certificates use.
code_repo=$(gh api "repos/${code_repo}" --jq .full_name) || die "can't find ${code_repo} on GitHub"
hosting=$(gh api "repos/${hosting}" --jq .full_name) || die "can't find ${hosting} on GitHub"
org=${hosting%%/*}
[[ $code_repo =~ $repo_re && $hosting =~ $repo_re ]] || die "GitHub returned unexpected repository names"
echo "Expecting a site built from ${code_repo} (${branch}) by ${hosting}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
work=$(cd -P -- "$work" && pwd) # symlinks resolved, so paths below compare as written
mkdir "$work/site"

failed=0

# Every Pages site of an owner is served from one origin. Another repository
# with Pages in the hosting organization would get a page on the app's origin,
# which could use the keys the app keeps in the browser; nothing below would
# fetch it.
echo "Listing ${org}'s repositories with Pages"
pages=$(gh api --paginate "orgs/${org}/repos?per_page=100" --jq '.[] | select(.has_pages) | .full_name') \
  || die "can't list ${org}'s repositories"
others=$(grep -vxF -- "$hosting" <<<"$pages" || true)
if [ -n "$others" ]; then
  while IFS= read -r other; do
    echo "OTHER PAGES SITE ${other}"
  done <<<"$others"
  echo "  Pages sites of ${org}'s other repositories share the app's origin, https://${org}.github.io,"
  echo "  and with it the keys the app keeps in the browser. Only ${hosting} may have Pages."
  failed=1
elif ! grep -qxF -- "$hosting" <<<"$pages"; then
  echo "NO PAGES ${hosting} isn't listed with a Pages site"
  failed=1
else
  echo "ok        only ${hosting} has Pages"
fi

# No custom domain: with one, GitHub redirects the github.io address to it,
# the app's origin moves there, and whoever controls that domain's DNS could
# serve other pages on it.
root=$(curl -sS -o /dev/null --max-time 30 --proto '=https' -w '%{http_code} %{redirect_url}' "${site}/?nocache=$RANDOM") \
  || die "can't reach ${site}"
case $root in
  3*)
    echo "CUSTOM DOMAIN ${site} redirects to ${root#* }"
    failed=1 ;;
  200*) echo "ok        ${site} is served from its own address, with no custom domain" ;;
  *) echo "Note: ${site}/ answered HTTP ${root%% *}" ;;
esac

echo "Fetching ${site}/manifest.json"
manifest=$work/manifest.json
curl -fsS --max-time 30 --max-filesize 1048576 --proto '=https' "${site}/manifest.json?nocache=$RANDOM" -o "$manifest" \
  || refuse "Can't fetch manifest.json"
jq -e 'type == "object"' "$manifest" >/dev/null 2>&1 || refuse "manifest.json isn't a JSON object"

# The manifest's string field $1, if all of it matches the regex $2 (Oniguruma:
# \A and \z, since ^ and $ also match at line ends); otherwise nothing.
field() { jq -r --arg k "$1" --arg re "$2" '.[$k] | select(type == "string" and test($re))' "$manifest"; }
repository=$(field repository '\A[A-Za-z0-9-]+/[A-Za-z0-9._-]+\z')
ref=$(field ref '\A(v[0-9]+\.[0-9]+\.[0-9]+|[0-9a-f]{40})\z')
commit=$(field commit '\A[0-9a-f]{40}\z')
if [ -z "$repository" ] || [ -z "$ref" ] || [ -z "$commit" ]; then
  refuse "The manifest's repository, ref or commit is missing or malformed"
fi
# Paths and hashes too, before anything is fetched or written: the paths become
# file names under the temporary folder. Bad keys are printed as ASCII JSON, so
# control or bidirectional characters can't hide text on the terminal.
bad=$(jq -a --arg re '\A[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\z' '
  def plain: test($re) and (split("/") | all(. != "." and . != ".."));
  def sha256: type == "string" and test("\\A[0-9a-f]{64}\\z");
  if (.files | type) != "object" or (.files | length) == 0 then "(no files)"
  else .files | to_entries[] | select((.key | plain) and (.value | sha256) | not) | .key
  end' "$manifest")
if [ -n "$bad" ]; then
  refuse "The manifest lists paths that aren't plain relative paths, or hashes that aren't SHA-256:
$(head -n 5 <<<"$bad" | sed 's/^/  /')"
fi
echo "Built from ${repository} ${ref} (commit ${commit})"

# The commit: from the expected repository, on its main branch itself (among
# its first parents, as hosting/deploy.yml requires), and the tag's commit
# when the ref is a release tag.
if [ "$(lower "$repository")" != "$(lower "$code_repo")" ]; then
  echo "WRONG REPOSITORY built from ${repository}, not ${code_repo}"
  failed=1
fi
echo "Fetching ${code_repo}'s history"
git clone --quiet --filter=blob:none --no-checkout "https://github.com/${code_repo}.git" "$work/code" \
  || die "can't clone ${code_repo}"
code() { git -C "$work/code" "$@"; }
tip=$(code rev-parse --verify --quiet "refs/remotes/origin/${branch}") || die "${code_repo} has no ${branch} branch"
on_main=0
if grep -qxF -- "$commit" <(code rev-list --first-parent "refs/remotes/origin/${branch}"); then
  echo "ok        ${commit} is on ${code_repo}'s ${branch}"
  on_main=1
else
  echo "NOT ON MAIN ${commit} isn't on ${code_repo}'s ${branch} (first parents)"
  failed=1
fi
case $ref in
  v*)
    code fetch --quiet --no-tags origin "+refs/tags/${ref}:refs/tags/${ref}" 2>/dev/null || true
    tagged=$(code rev-parse --verify --quiet "refs/tags/${ref}^{commit}" || true)
    if [ "$tagged" = "$commit" ]; then
      echo "ok        ${ref} is tagged at ${commit}"
    else
      echo "WRONG TAG ${ref} isn't ${commit} in ${code_repo}"
      failed=1
    fi ;;
  *)
    if [ "$ref" != "$commit" ]; then
      echo "WRONG REF the manifest's ref ${ref} isn't its commit"
      failed=1
    fi ;;
esac

# Whether it is the newest build: the latest release tag for a site built
# from tags, the head of main for one built from commits. Only a warning: a
# deploy takes some minutes, and the operator may roll back on purpose.
stale=''
case $ref in
  v*)
    newest=$(code tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
    if [ -z "$newest" ]; then
      echo "Note: can't tell which release of ${code_repo} is the latest"
    elif [ "$newest" != "$ref" ]; then
      stale="the latest release of ${code_repo} is ${newest}, not ${ref}"
    else
      echo "ok        ${ref} is the latest release"
    fi ;;
  *)
    if [ "$on_main" = 1 ] && [ "$commit" != "$tip" ]; then
      behind=$(code rev-list --count --first-parent "${commit}..${tip}" 2>/dev/null || echo some)
      stale="${code_repo}'s ${branch} is at ${tip}, ${behind} commit(s) after the site's"
    elif [ "$on_main" = 1 ]; then
      echo "ok        ${commit} is the head of ${branch}"
    fi ;;
esac
if [ -n "$stale" ]; then
  echo "NOT LATEST ${stale}"
  echo "  Normal while a deploy is running. Otherwise the site is behind, or was rolled back."
fi

# The signing workflow: the hosting repository's deploy.yml, run from its main
# branch on GitHub's own runners, at a commit (the certificate's signer digest)
# where it is byte for byte a copy of hosting/deploy.yml that was on this
# repository's main. A changed workflow, even one changed back later, fails,
# also next to a reviewed one.
identity="https://github.com/${hosting}/.github/workflows/deploy.yml@refs/heads/${branch}"
attest() { # file [flags]: gh attestation verify with the pins every check uses
  gh attestation verify "$1" --repo "$hosting" --cert-identity "$identity" \
    --source-ref "refs/heads/${branch}" --deny-self-hosted-runners --limit 100 "${@:2}"
}
# Every reviewed copy: its blob, and the commit that brought it to main.
reviewed=$(code rev-list --first-parent "refs/remotes/origin/${branch}" -- hosting/deploy.yml | while read -r c; do
  blob=$(code rev-parse --verify --quiet "${c}:hosting/deploy.yml") && echo "${blob} ${c}"
done || true)
signers=$(attest "$manifest" --format json --jq '.[].verificationResult.signature.certificate.buildSignerDigest' \
  2>"$work/attest.err" | sort -u || true)
[ -n "$signers" ] || tail -n 3 "$work/attest.err" | sed 's/^/  gh: /'
approved=()
while IFS= read -r digest; do
  [[ $digest =~ ^[0-9a-f]{40}$ ]] || continue
  if ! gh api -H 'Accept: application/vnd.github.raw' \
    "repos/${hosting}/contents/.github/workflows/deploy.yml?ref=${digest}" >"$work/deploy-${digest}.yml" 2>/dev/null; then
    echo "UNREVIEWED WORKFLOW can't read ${hosting}'s deploy.yml at ${digest}"
    failed=1
    continue
  fi
  blob=$(code hash-object --no-filters "$work/deploy-${digest}.yml")
  copy=$(awk -v b="$blob" '$1 == b { print $2; exit }' <<<"$reviewed")
  if [ -n "$copy" ]; then
    echo "ok        signed by ${hosting}'s deploy.yml at ${digest}, the copy from ${code_repo}@${copy:0:12}"
    approved+=("$digest")
  else
    echo "UNREVIEWED WORKFLOW ${hosting}'s deploy.yml at ${digest} isn't a copy of hosting/deploy.yml from ${code_repo}'s ${branch}"
    failed=1
  fi
done <<<"$signers"
attested() { # file: attested by an approved signer
  local digest
  for digest in ${approved[@]+"${approved[@]}"}; do
    attest "$1" --signer-digest "$digest" >/dev/null 2>&1 && return 0
  done
  return 1
}
manifest_ok=0
if [ "${#approved[@]}" -gt 0 ] && attested "$manifest"; then
  echo "ok        manifest.json"
  manifest_ok=1
else
  echo "UNATTESTED manifest.json"
  failed=1
fi

# How the live site got there. GitHub serves the newest github-pages
# deployment that succeeded (a failed or running one leaves the old site up).
# It must have been made by one of the runs that signed this manifest, with a
# reviewed deploy.yml: not by another workflow, nor by Pages building a branch
# (GitHub's own pages-build-deployment). The deployment records come from the
# API: an admin of the hosting organization could forge them (docs/verifying.md).
echo "Checking how ${site} was deployed"
signed_runs=()
for digest in ${approved[@]+"${approved[@]}"}; do
  while IFS= read -r run; do
    [[ $run =~ ^[0-9]+$ ]] && signed_runs+=("$run")
  done < <(attest "$manifest" --signer-digest "$digest" --format json \
    --jq '.[].verificationResult.signature.certificate.runInvocationURI' 2>/dev/null \
    | sed -n "s|^https://github\.com/${hosting}/actions/runs/\([0-9]*\)/attempts/[0-9]*\$|\1|p")
done
deploys=$(gh api "repos/${hosting}/deployments?environment=github-pages&per_page=30" --jq '.[].id') \
  || die "can't list ${hosting}'s deployments"
live_url='' running=0
while IFS= read -r id; do
  [[ $id =~ ^[0-9]+$ ]] || continue
  status=$(gh api "repos/${hosting}/deployments/${id}/statuses?per_page=1" \
    --jq '.[0] | "\(.state) \(.log_url // "")"') || die "can't read ${hosting}'s deployment ${id}"
  case ${status%% *} in
    success) live_url=${status#* }; break ;;
    queued|pending|in_progress|waiting) running=1 ;;
  esac
done <<<"$deploys"
[ "$running" = 0 ] || echo "Note: a newer deploy is running; the live site is the one before it"
live_run=''
case $live_url in
  "https://github.com/${hosting}/actions/runs/"*)
    live_run=${live_url#"https://github.com/${hosting}/actions/runs/"}
    live_run=${live_run%%/*} ;;
esac
if ! [[ $live_run =~ ^[0-9]+$ ]]; then
  echo "UNKNOWN DEPLOY no successful github-pages deployment names a workflow run of ${hosting}"
  failed=1
else
  run_info=$(gh api "repos/${hosting}/actions/runs/${live_run}" --jq '"\(.path)\t\(.head_branch)"') \
    || die "can't read ${hosting}'s run ${live_run}"
  if [ "$run_info" != ".github/workflows/deploy.yml"$'\t'"${branch}" ]; then
    echo "OTHER DEPLOYER the live site was deployed by run ${live_run} ($(tr '\t' ' ' <<<"$run_info")), not deploy.yml on ${branch}"
    failed=1
  elif ! printf '%s\n' ${signed_runs[@]+"${signed_runs[@]}"} | grep -qxF -- "$live_run"; then
    echo "OTHER DEPLOYER the live site was deployed by run ${live_run}, which didn't sign this manifest"
    failed=1
  else
    echo "ok        deployed by run ${live_run} of deploy.yml, which signed this manifest"
  fi
fi

check() { # path expected-sha256
  local path=$1 want=$2 file dir got
  # Checked above already; again here, since the path becomes a file name.
  if ! [[ $path =~ $path_re ]] || [[ /$path/ == */./* || /$path/ == */../* ]]; then
    echo "BAD PATH  ${path}"
    failed=1
    return
  fi
  file=$work/site/$path
  dir=${file%/*}
  mkdir -p -- "$dir" 2>/dev/null || { echo "BAD PATH  ${path}"; failed=1; return; }
  case "$(cd -P -- "$dir" && pwd)/" in
    "$work/site/"*) ;;
    *) echo "BAD PATH  ${path}"; failed=1; return ;;
  esac
  if ! curl -fsS --max-time 60 --max-filesize 20971520 --proto '=https' --path-as-is \
    "${site}/${path}?nocache=$RANDOM" -o "$file"; then
    echo "MISSING   ${path}"
    failed=1
    return
  fi
  got=$(sha256sum "$file" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    echo "MISMATCH  ${path}"
    failed=1
  elif ! attested "$file"; then
    echo "UNATTESTED ${path}"
    failed=1
  else
    echo "ok        ${path}"
  fi
}

# Only the files of a manifest that a reviewed workflow made.
if [ "$manifest_ok" = 1 ]; then
  while IFS=$'\t' read -r path sha; do
    check "$path" "$sha"
  done < <(jq -r '.files | to_entries[] | "\(.key)\t\(.value)"' "$manifest")
else
  echo "Not fetching the files the manifest lists: it isn't attested by a reviewed workflow"
fi

if [ "$rebuild" = 1 ] && [ "$failed" != 0 ]; then
  echo "Not rebuilding: the checks above failed"
elif [ "$rebuild" = 1 ]; then
  # Only with the Node the site was built with: npm ci refuses an older one
  # (engine-strict in web/.npmrc), and another one may build other bytes.
  node=$(field node '\Av[0-9]+\.[0-9]+\.[0-9]+\z')
  [ -n "$node" ] || refuse "REBUILD FAILED the manifest doesn't say which Node built the site"
  have=$(node --version 2>/dev/null) || have='an unknown version'
  if [ "$node" != "$have" ]; then
    die "the site was built with Node ${node}, this is ${have}; switch to ${node} (with nvm: nvm install ${node#v}) and run again, or run without --rebuild"
  fi
  # Only the expected repository, at the commit checked above.
  echo "Rebuilding ${commit} from ${code_repo}"
  built=0
  if ! code -c advice.detachedHead=false checkout --quiet --detach "$commit"; then
    echo "REBUILD FAILED can't check out ${commit}"
  elif ! (
    if [ -n "$caller_lc_all_set" ]; then export LC_ALL=$caller_lc_all; else unset LC_ALL; fi
    # Only the manifest's settings: every VITE_ variable, even an unused or
    # empty one, is part of the bundle. Older builds also took the named
    # Mini App's short name, so it's set only when the manifest has it.
    unset "${!VITE_@}"
    if jq -e '.build | has("VITE_APP_NAME")' "$manifest" >/dev/null; then
      VITE_APP_NAME=$(jq -r .build.VITE_APP_NAME "$manifest") && export VITE_APP_NAME
    fi
    # set -e is off inside a condition, so each step is chained.
    cd "$work/code/web" \
      && npm ci --ignore-scripts --silent \
      && VITE_API_URL=$(jq -r .build.VITE_API_URL "$manifest") \
        VITE_BOT_USERNAME=$(jq -r .build.VITE_BOT_USERNAME "$manifest") \
        VITE_ISSUER_KEY=$(jq -r '.build.VITE_ISSUER_KEY // empty' "$manifest") \
        VITE_WS_URL=$(jq -r '.build.VITE_WS_URL // empty' "$manifest") \
        VITE_MEDIA_ORIGIN=$(jq -r '.build.VITE_MEDIA_ORIGIN // empty' "$manifest") \
        npm run build --silent >/dev/null
  ); then
    echo "REBUILD FAILED npm ci or npm run build failed (output above)"
  else
    built=1
  fi
  differs=0
  if [ "$built" = 1 ]; then
    while IFS=$'\t' read -r path sha; do
      got=$(sha256sum "$work/code/web/dist/$path" 2>/dev/null | cut -d' ' -f1 || true)
      if [ "$got" != "$sha" ]; then
        echo "REBUILD DIFFERS ${path}"
        differs=1
      fi
    done < <(jq -r '.files | to_entries[] | "\(.key)\t\(.value)"' "$manifest")
    # And the manifest lists every file the build makes.
    while IFS= read -r path; do
      echo "NOT IN MANIFEST ${path}"
      differs=1
    done < <(comm -23 <(cd "$work/code/web/dist" && find . -type f | sed 's|^\./||' | sort) \
      <(jq -r '.files | keys[]' "$manifest" | sort))
  fi
  if [ "$built" = 1 ] && [ "$differs" = 0 ]; then
    echo "Rebuild matches byte for byte"
  else
    failed=1
  fi
fi

if [ "$failed" != 0 ]; then
  echo "VERIFICATION FAILED"
  exit 1
fi
echo "Verified: every file matches the manifest and is attested by a reviewed copy of hosting/deploy.yml"
echo "in ${hosting}, built from ${code_repo} ${ref} (commit ${commit}, on ${branch}) and deployed by the run that signed it;"
echo "no other ${org} repository has Pages, and there's no custom domain"
if [ -n "$stale" ]; then
  echo "Warning: it isn't the newest build (NOT LATEST above)"
fi
