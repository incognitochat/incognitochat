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
  build any other. And it only moves forward: it refuses a commit older than
  the live site's, or a release lower than the live one, unless the request
  says `rollback: true`
  ([hosting/README.md](../hosting/README.md#rolling-back)). This repository
  starts the workflow with a token that can't change the hosting
  repository's files or settings, but can still start the workflow with any
  inputs (`rollback: true` included), re-run, cancel and delete its runs, and
  turn it off: whoever holds it can keep the site from updating, or roll it
  back to an older build of `main`, but can't publish anything else.
- **Locked down at runtime.** A strict Content Security Policy allows only the
  app's own scripts, and connections only to the API, the socket, the
  attachment bucket and the app's own origin (for the sticker art). The app
  loads no third-party code, and no code or settings from the backend.

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
   a public repository.) And `https://<org>.github.io/` answers itself,
   without redirecting: a custom domain would move the app's origin to a
   domain whose DNS someone else could control.
2. `manifest.json` names the expected repository, a full commit SHA, and as
   its ref that commit or a release tag (`vX.Y.Z`). Every path it lists must
   be a plain relative path (letters, digits, `.`, `_`, `-`, separated by
   `/`, with no `.` or `..` segment), so a hostile manifest can't make the
   script write outside its temporary folder.
3. The commit is on `main` itself, among its first parents (as the hosting
   workflow requires: a commit that only came in through a merge doesn't
   count), and a release tag points at it. It warns, without failing, when
   that isn't the newest build: the latest release tag for a site built from
   tags, the head of `main` for one built from commits. That's normal while
   a deploy runs; otherwise the site is behind, or was rolled back.
4. The manifest is attested by the hosting repository's
   `.github/workflows/deploy.yml`, run from that repository's `main` on
   GitHub's own runners, at a commit where that file is byte for byte a copy
   of [`hosting/deploy.yml`](../hosting/deploy.yml) that was on this
   repository's `main`. A changed workflow fails, even one changed back
   afterwards, and even when a reviewed copy signed the same manifest too.
   Without such an attestation, the script doesn't fetch the files the
   manifest lists.
5. The live site was deployed by one of the runs that signed the manifest:
   the newest `github-pages` deployment that succeeded names a run of the
   hosting repository's `deploy.yml` on `main`, and that run is one of those
   the manifest's attestations name. Not another workflow, and not Pages
   building a branch (GitHub's own `pages-build-deployment`).
6. Every file the manifest lists is served with that SHA-256, and attested by
   the same workflow.
7. With `--rebuild`, and only if everything above passed: it clones the
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
`--rebuild` also needs the Node the manifest says built the site: the version
in [`web/.nvmrc`](../web/.nvmrc) at the site's commit. With another one the
script stops before building (exit code 2) and names the version to use.

## Checking what the bot opens

`verify-site.sh` checks what the app's address serves. Whoever controls the
bot in BotFather decides which address Telegram opens, so
`scripts/verify-bot.py` checks the other half, as one Telegram account sees
it:

- **main:** the bot's Main Mini App, which `t.me/<bot>?startapp` links open.
  It must be set.
- **menu:** the bot's menu button. It must open the app.
- **welcome:** the app buttons in the bot's replies to `/start`. It sends
  `/start`, reads the replies (for up to 20 seconds, until none has come for
  4), reads them once more, then deletes them all; `--no-start` skips this.
  No reply at all means it couldn't check, not that it failed.

Each must open `https://<org>.github.io/` exactly. The menu button and the
`/start` buttons are the bot's own addresses, so they must be exactly that,
with nothing after it. The Main Mini App's address is typed in BotFather
(the final `/` may be left out: a browser adds it) and comes back from
Telegram with its launch parameters added in the fragment, so it may carry
Telegram's `tgWebApp…` keys, each once, and nothing else: no query, no start
parameter (the script asks for none), no second `#`. The script sends a
fixed theme with its request, so Telegram adds its own theme parameter and a
planted one is a second copy. The app acts on some parameters (a start
parameter, `#save=`, the first copy of a launch parameter), so one planted
in the address the operator set fails. Every address any version of a reply
carried counts, so a button edited away and back fails too. The fragment
Telegram adds holds your account's signed launch data, which logs that
account in to the app's server for a while. So the script never loads the
page, and prints only an address's origin and path and the names of
unexpected parameters.

```shell
python3 -m venv ~/.cache/verify-bot
~/.cache/verify-bot/bin/pip install --require-hashes --only-binary :all: -r scripts/verify-bot.build.txt
~/.cache/verify-bot/bin/pip install --require-hashes --no-build-isolation -r scripts/verify-bot.requirements.txt
TG_API_ID=<id> TG_API_HASH=<hash> ~/.cache/verify-bot/bin/python scripts/verify-bot.py <bot> https://<org>.github.io
```

The packages are [Telethon](https://codeberg.org/Lonami/Telethon), a
client for Telegram's user API, and its dependencies, pinned by hash. The
first file is setuptools, which pip needs to build one of them, so that
everything pip downloads is checked. It needs Python 3.11 or later.

It logs in as you, because only a user account can ask Telegram what it
opens. Get an `api_id` and `api_hash` for yourself at
[my.telegram.org](https://my.telegram.org) (Telegram's rules require each app
to use its own). Then, in a terminal, type your phone number, the code
Telegram sends you, and your password if you set one. The login stays in
memory and the script logs it out at the end. If a run is cut short (a lost
connection, a killed process), the login can stay listed among your
account's devices until you end it there (Settings, Devices).

Exit codes: 0 verified; 1 verification failed, also when another check
couldn't run; 2 couldn't run or couldn't finish (setup, login, network,
Telegram limits, no reply to `/start`). If deleting the `/start` messages or
logging out fails, it says so and keeps the result.

For a check that runs without anyone typing a code, `--make-session` logs in
once and prints a session string; with it in `TG_SESSION`, the script logs
in without prompts. The string is a login to that account: keep it secret,
use an account made for this, not your own, and use the string in one place
only (Telegram ends a session used from two places at once).

**What it shows:** what Telegram opens for that account, at that moment. A
change in BotFather (the Main Mini App) or to the default menu button is for
everyone, so any account's check sees it. A per-chat menu button, or a button
the bot sends only to some people, is invisible to everyone else's checks:
only your own run shows what you are served.

**What it doesn't check:**

- the button in the bot's notices (it uses the same address as the welcome
  button, but a notice comes only when there's news);
- named Mini Apps (`t.me/<bot>/<name>`): the app's links don't use them,
  and Telegram doesn't list a bot's Mini Apps, so a new one wouldn't be seen;
- links in the bot's replies that aren't app buttons, and inline mode;
- replies to `/start` that come after it deleted the messages;
- the parameters a link someone shares carries: anyone can put a start
  parameter in a `t.me` link. It checks only what the bot's own entry
  points add.

## What this proves, and what it doesn't

- **Proves:** the files the manifest lists are, right now, exactly what an
  unchanged copy of the hosting workflow built from a commit on this
  repository's `main` (or a release tag at such a commit), for everyone who
  fetches them, and with `--rebuild`, what that commit's code builds into.
  And that no other repository of the organization has a Pages site, that
  there's no custom domain, and that, by GitHub's deployment records, the
  live site was deployed by a run that signed the manifest. It
  doesn't check whether the site builds commits or tags: the manifest's ref
  says which.
- **Doesn't prove** what one particular person was served inside Telegram. A
  bot owner could point the app at another address, for everyone or for
  chosen people. `scripts/verify-bot.py` checks what Telegram opens for the
  account that runs it ([above](#checking-what-the-bot-opens)), so you can
  check what you are served yourself. A page on any other address has none of the keys on your
  device: it would have to make you set up again, which ends your account
  loudly on your old device and changes your link. A page on the app's own
  address would have them, which is why nothing else may be served there.
- **Doesn't see files the manifest doesn't list.** It can't list what a
  site serves, only fetch what the manifest names. Extra pages deployed by
  another workflow, or by switching Pages to deploy from a branch, fail
  check 5: the live deployment would name that run, not one that signed the
  manifest. What stays open: the deployment records come from GitHub's API,
  and an admin of the hosting organization can create deployment records and
  statuses that name any run, rewrite the repository's history (force-push
  `main`), and delete runs and deployments. So an admin who deploys extra
  pages and then forges the records isn't caught; one who doesn't is.
- **Doesn't fail an old build.** It warns when the site isn't the newest
  build, but still verifies it: a site held back, or rolled back on purpose,
  is still a genuine build of `main`. It prints the commit and ref it
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
  for the same commit (`scripts/build-lambdas.sh` prints their SHA-256). Each
  deploy checks that the bundles it received are the ones CI's build job
  hashed, then attests them with Sigstore before deploying them.
- **Only signed code runs.** Each bundle is signed with the environment's
  AWS Signer profile, and every function has a code signing config that
  makes Lambda refuse anything not signed by it. The deploy role is what
  signs, and it can sign any object it uploads: a signature shows that the
  code came through that role, not that it was built from this repository.
  The deploy role can't change the profile or the config, nor create or
  keep a function without it.
- **Each deploy checks what it deployed.** After deploying, the same job
  fetches the code each function runs from Lambda and checks that it is the
  attested bundle plus AWS's signature, and nothing else, and that it runs
  as the app stack sets it: a .zip with no layers, on the stack's runtime,
  architecture and handler (`scripts/check-lambda-deploy.py`). The public
  log of the "Check the deployed code" step shows both hashes. The check
  runs inside the deploy it checks, so a compromised deploy could lie in
  its own log, and it covers the code, not the rest of the functions'
  settings (their environment variables, say).

So what ties the running code to this repository is a rebuild made
elsewhere, compared with the hashes in the deploy log. To check a deploy,
rebuild its commit and compare:

```shell
git checkout <commit> && cd backend && ../scripts/build-lambdas.sh
gh attestation verify dist/api.zip --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/deploy-environment.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

The hashes printed should match the deploy log's ("Check the bundles are
the backend job's" and "Check the deployed code"). The attestation adds
that the bundle was attested by this repository's deploy workflow, run on
GitHub's own runners for `main` (dev). For a production deploy, use
`--source-ref refs/tags/vX.Y.Z`, its release tag. As for the site, use gh
2.102.0 or later: before it, `--signer-workflow` matched only a prefix and
`--source-ref` ignored case.

`build-lambdas.sh` builds with the Go toolchain `backend/go.mod` pins (its
`toolchain` line), whatever Go is installed: with another version, Go
downloads the pinned one first, checked against Go's checksum database (the
installed Go must be 1.21 or later).

What this doesn't prove:

- What ran after the check. A compromised deploy, or a stolen session of
  the deploy role (one lasts up to 30 minutes), can sign and deploy other
  code, or change the functions' settings, once the check has run. The next
  deploy's check fails if that code still runs (unless the deploy replaced
  it first, with a changed bundle), and its plan shows and undoes changed
  settings, but only the account's own audit trail shows what ran in
  between ([deployment.md](deployment.md#audit-trail-and-change-alerts)).
- That signing stayed on: whoever controls the AWS account can switch it
  off and deploy something else, and only the account's own records would
  show it (the audit trail, and an email to its admin, which they can turn
  off too).

Signing in a separate role that signs only attested hashes, and change
alerts held by an independent party, are
[future improvements](security.md#how-the-remaining-gaps-could-close).
