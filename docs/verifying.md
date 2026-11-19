# Verifying the app

The encryption only protects you if the app you run is the app in this
repository. Inside Telegram, nothing stops whoever runs the bot from pointing
it at a different page ([security.md](security.md#what-users-still-have-to-trust)),
so the app is built so that anyone can check what is actually served.

## How the app is published

- **Reproducible builds.** The same commit always produces byte-identical
  files. CI builds the app twice and fails if anything differs; it does the
  same for the backend's Lambda bundles.
- **A hosting repository of its own.** The app is served by GitHub Pages at
  the root of a dedicated GitHub organization's `github.io` address. All Pages
  sites of one owner share one web origin, and with it the keys stored in the
  browser, so that organization hosts nothing else (the script below checks
  it), and no custom domain is set (whoever controlled the domain's DNS could
  otherwise serve a page on the same origin). The dev site has a separate
  organization, so it never shares keys with production.
- **Built where it's served.** The hosting repository holds no application
  code, only a workflow ([`hosting/deploy.yml`](../hosting/deploy.yml)) that
  checks out one commit (dev) or release tag (production) of this repository,
  builds it, writes `manifest.json` (the commit, the build settings and the
  SHA-256 of every file), attests every file and the manifest with Sigstore,
  and deploys with GitHub's own Pages action. It builds only a commit on
  `main` itself (not one merged in from another branch); CI's request also
  names the commit it deployed the backend from, and the workflow refuses to
  build any other. This repository can only start that workflow, with a
  token that can do nothing else.
- **Locked down at runtime.** A strict Content Security Policy allows only the
  app's own scripts, and connections only to the API, the socket and the
  attachment bucket. The app loads no third-party code, and no code or settings
  from the backend.

## Checking a live site

```shell
scripts/verify-site.sh https://<org>.github.io <org>/<org>.github.io --rebuild
```

Run it from a checkout of this repository: the site must be built from the
GitHub repository that the checkout's `origin` points to, or the one named
with `--code-repo <owner>/<repo>`. Everything the site serves is untrusted
until checked. The script checks, in this order:

1. No repository of the hosting organization other than the hosting
   repository has a Pages site. Their pages would be served from the app's
   origin, with access to the keys in the browser. (It sees the public
   repositories; on the free plan, which the organization keeps, Pages needs
   a public repository.)
2. `manifest.json` names the expected repository, a full commit SHA, and as
   its ref that commit or a release tag (`vX.Y.Z`). Every path it lists must
   be a plain relative path (letters, digits, `.`, `_`, `-`, separated by
   `/`, with no `.` or `..` segment), so a hostile manifest can't make the
   script write outside its temporary folder.
3. The commit is on `main` itself, among its first parents (as the hosting
   workflow requires: a commit that only came in through a merge doesn't
   count), and a release tag points at it.
4. The manifest is attested by the hosting repository's
   `.github/workflows/deploy.yml`, run from that repository's `main` on
   GitHub's own runners, at a commit where that file is byte for byte a copy
   of [`hosting/deploy.yml`](../hosting/deploy.yml) that was on this
   repository's `main`. A changed workflow fails, even one changed back
   afterwards, and even when a reviewed copy signed the same manifest too.
   Without such an attestation, the script doesn't fetch the files the
   manifest lists.
5. Every file the manifest lists is served with that SHA-256, and attested by
   the same workflow.
6. With `--rebuild`, and only if everything above passed: it clones the
   expected repository at that commit, builds it with the manifest's settings
   (`npm ci --ignore-scripts`, then `npm run build`), and checks that the
   build makes exactly the files listed, byte for byte.

The attestations are Sigstore signatures in a public transparency log. The
script checks them with
[`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify),
pinned to the signing workflow:

```shell
gh attestation verify <file> --repo <org>/<org>.github.io \
  --cert-identity https://github.com/<org>/<org>.github.io/.github/workflows/deploy.yml@refs/heads/main \
  --source-ref refs/heads/main --deny-self-hosted-runners --signer-digest <hosting commit>
```

`--cert-identity` must match the certificate's workflow and ref exactly
(`--signer-workflow` matched only a prefix before gh 2.102.0).
`--signer-digest` is the hosting repository's commit the workflow ran from,
as the certificate records it; the script first reads it from the manifest's
attestations and compares `deploy.yml` at that commit with the reviewed
copies. `--signer-digest` and `--source-ref` need gh 2.68.0 or later.

It needs `curl`, `jq`, `sha256sum`, `git` and the GitHub CLI, logged in
(`gh auth login`, any account: the CLI doesn't read even public attestations
without a login). Use gh 2.102.0 or later: before 2.93.0, `gh attestation`
sent the login token to the host of Sigstore's TUF mirror
([GHSA-8xvp-7hj6-mcj9](https://github.com/advisories/GHSA-8xvp-7hj6-mcj9)),
so the script refuses those versions, and warns below 2.102.0.
`--rebuild` also needs the Node version in [`web/.nvmrc`](../web/.nvmrc).

## What this proves, and what it doesn't

- **Proves:** the files the manifest lists are, right now, exactly what an
  unchanged copy of the hosting workflow built from a commit on this
  repository's `main` (or a release tag at such a commit), for everyone who
  fetches them, and with `--rebuild`, what that commit's code builds into.
  And that no other repository of the organization has a Pages site. It
  doesn't check whether the site builds commits or tags: the manifest's ref
  says which.
- **Doesn't prove** what one particular person was served inside Telegram. A
  bot owner could point the app at another address, for everyone or for
  chosen people. A page on any other address has none of the keys on your
  device: it would have to make you set up again, which ends your account
  loudly on your old device and changes your link. A page on the app's own
  address would have them, which is why nothing else may be served there.
- **Doesn't see files the manifest doesn't list.** Whoever controls the
  hosting repository could publish an attested build together with extra
  pages on the app's origin: through a changed `deploy.yml`, another workflow
  allowed to deploy Pages, or by switching Pages to deploy from a branch,
  without touching `deploy.yml`. Nothing the script checks would catch it.
  The change may show in the hosting repository's public history and
  Actions runs, but an admin of the hosting organization can rewrite that
  history (force-push `main`) and delete runs and deployments.
- **Doesn't say the build is the newest.** It prints the commit and ref it
  checked; compare them with the release or commit you expect.
- **Covers the backend only through the operator's records** (below). The
  design doesn't rely on the backend: a malicious one can drop or delay
  messages and watch timing, but can't read content or forge messages,
  because apps check every key themselves.

Native apps with reproducible builds, and web standards for pinning a site's
code (WEBCAT, WAICT), would close the first gap; they're on the
[list of future improvements](security.md#how-the-remaining-gaps-could-close).

## The backend

Users can't look into the AWS account, so the backend is checked through
what CI publishes:

- **Reproducible and attested.** The four Lambda bundles are byte-identical
  for the same commit (`scripts/build-lambdas.sh` prints their SHA-256), and
  each deploy attests them with Sigstore before deploying them.
- **Only signed code runs.** Each bundle is signed with the environment's AWS
  Signer profile, and every function has a code signing config that makes
  Lambda refuse anything not signed by it. CI is the only place that signs;
  the deploy role can't change the profile or the config, nor create or keep
  a function without it.
- **Each deploy checks itself.** After deploying, CI fetches the code each
  function runs from Lambda and checks that it is the attested bundle plus
  AWS's signature, and nothing else (`scripts/check-lambda-deploy.py`). The
  public log of the "Check the deployed code" step shows both hashes.

To check a deploy, rebuild its commit and compare:

```shell
git checkout <commit> && cd backend && ../scripts/build-lambdas.sh
gh attestation verify dist/api.zip --repo <org>/<org>
```

The hashes printed should match the deploy log, and the attestation proves
the bundle was built by this repository's workflow.

What this doesn't prove: whoever controls the AWS account can switch code
signing off and deploy something else, and only the account's own records
(CloudTrail) would show it. Change alerts held by an independent party are a
[future improvement](security.md#how-the-remaining-gaps-could-close).
