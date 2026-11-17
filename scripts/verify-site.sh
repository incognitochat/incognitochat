#!/usr/bin/env bash
# Checks that a live site is exactly what a reviewed copy of the hosting
# workflow built from this repository's main branch, and optionally that
# rebuilding the same commit gives the same bytes (design §16).
#
#   scripts/verify-site.sh <site URL> <hosting repository> [--rebuild] [--code-repo <owner>/<repo>]
#   scripts/verify-site.sh https://<org>.github.io <org>/<org>.github.io --rebuild
#
# Everything the site serves is untrusted until checked, the manifest's paths,
# repository and commit included. The code repository the site must be built
# from is this checkout's origin on GitHub, or --code-repo. What it checks is
# listed in docs/verifying.md.
#
# Needs curl, jq, sha256sum, git and the GitHub CLI, logged in (gh auth login,
# any account: it only reads public data). --rebuild also needs Node (the
# version in web/.nvmrc).
set -euo pipefail

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

echo "Fetching ${site}/manifest.json"
manifest=$work/manifest.json
curl -fsS --max-time 30 --proto '=https' "${site}/manifest.json?nocache=$RANDOM" -o "$manifest" \
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
# file names under the temporary folder.
bad=$(jq -r --arg re '\A[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\z' '
  def plain: test($re) and (split("/") | all(. != "." and . != ".."));
  def sha256: type == "string" and test("\\A[0-9a-f]{64}\\z");
  if (.files | type) != "object" or (.files | length) == 0 then "(no files)"
  else .files | to_entries[] | select((.key | plain) and (.value | sha256) | not) | .key | @json
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
code rev-parse --verify --quiet "refs/remotes/origin/${branch}" >/dev/null || die "${code_repo} has no ${branch} branch"
if grep -qxF -- "$commit" <(code rev-list --first-parent "refs/remotes/origin/${branch}"); then
  echo "ok        ${commit} is on ${code_repo}'s ${branch}"
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

# The signing workflow: the hosting repository's deploy.yml, run from its main
# branch on GitHub's own runners, at a commit (the certificate's signer digest)
# where it is byte for byte a copy of hosting/deploy.yml that was on this
# repository's main. A changed workflow, even one changed back later, fails.
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
    continue
  fi
  blob=$(git hash-object --no-filters "$work/deploy-${digest}.yml")
  copy=$(awk -v b="$blob" '$1 == b { print $2; exit }' <<<"$reviewed")
  if [ -n "$copy" ]; then
    echo "ok        signed by ${hosting}'s deploy.yml at ${digest}, the copy from ${code_repo}@${copy:0:12}"
    approved+=("$digest")
  else
    echo "UNREVIEWED WORKFLOW ${hosting}'s deploy.yml at ${digest} isn't a copy of hosting/deploy.yml from ${code_repo}'s ${branch}"
  fi
done <<<"$signers"
attested() { # file: attested by an approved signer
  local digest
  for digest in ${approved[@]+"${approved[@]}"}; do
    attest "$1" --signer-digest "$digest" >/dev/null 2>&1 && return 0
  done
  return 1
}
if [ "${#approved[@]}" -gt 0 ] && attested "$manifest"; then
  echo "ok        manifest.json"
else
  echo "UNATTESTED manifest.json"
  failed=1
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
  if ! curl -fsS --max-time 30 --proto '=https' --path-as-is "${site}/${path}?nocache=$RANDOM" -o "$file"; then
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

while IFS=$'\t' read -r path sha; do
  check "$path" "$sha"
done < <(jq -r '.files | to_entries[] | "\(.key)\t\(.value)"' "$manifest")

if [ "$rebuild" = 1 ] && [ "$failed" != 0 ]; then
  echo "Not rebuilding: the checks above failed"
elif [ "$rebuild" = 1 ]; then
  # Only the expected repository, at the commit checked above.
  echo "Rebuilding ${commit} from ${code_repo}"
  code -c advice.detachedHead=false checkout --quiet --detach "$commit"
  node=$(field node '\Av[0-9]+\.[0-9]+\.[0-9]+\z')
  if [ "$node" != "$(node --version)" ]; then
    echo "Note: the site was built with Node ${node:-?}, this is $(node --version); files may differ"
  fi
  (
    cd "$work/code/web"
    npm ci --ignore-scripts --silent
    VITE_API_URL=$(jq -r .build.VITE_API_URL "$manifest") \
    VITE_BOT_USERNAME=$(jq -r .build.VITE_BOT_USERNAME "$manifest") \
    VITE_APP_NAME=$(jq -r .build.VITE_APP_NAME "$manifest") \
    VITE_ISSUER_KEY=$(jq -r '.build.VITE_ISSUER_KEY // empty' "$manifest") \
    VITE_WS_URL=$(jq -r '.build.VITE_WS_URL // empty' "$manifest") \
    VITE_MEDIA_ORIGIN=$(jq -r '.build.VITE_MEDIA_ORIGIN // empty' "$manifest") \
      npm run build --silent >/dev/null
  )
  differs=0
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
  done < <(LC_ALL=C comm -23 <(cd "$work/code/web/dist" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) \
    <(jq -r '.files | keys[]' "$manifest" | LC_ALL=C sort))
  if [ "$differs" = 0 ]; then
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
echo "in ${hosting}, built from ${code_repo} ${ref} (commit ${commit}, on ${branch}); no other ${org} repository has Pages"
