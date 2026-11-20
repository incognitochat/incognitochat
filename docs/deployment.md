# Deployment

How an environment is set up and deployed. Each environment (dev, production)
has its own AWS account, its own GitHub environment in this repository, its
own bot, and its own hosting organization and repository for the app.

Nothing environment-specific is committed: account IDs, bucket names, bot
names, URLs and tokens live in GitHub environment secrets and variables and in
the hosting repository's variables. Below, `<env>`, `<bot>`, `<app>` and
`<org>` are placeholders.

## How a deploy runs

- A push to `main` runs CI, which deploys to **dev**. A published release
  deploys to **production**, once a required reviewer approves it
  ([releases](#releases)). Pull requests never get cloud access.
- CI assumes the environment's deploy role through GitHub's OIDC provider (no
  stored AWS keys), builds the Lambda bundles reproducibly and attests them,
  and applies `infra/` with Terraform, which uploads each bundle, has AWS
  Signer sign it, and deploys the signed copy. The deploy role is limited by
  the bootstrap stack and can't change its own permissions or read user
  data itself. Most ways to leave access behind unseen are denied, and each
  deploy checks for some of the rest
  ([what it may do](#what-the-deploy-role-may-do)).
- It checks that each function runs the attested bundle plus its signature
  ([verifying.md](verifying.md#the-backend)).
- It then sets up the bot (the function registers its own webhook, menu
  button and commands, so the calls to Telegram are made inside it, not in
  CI, though the bot token reaches CI too: [secrets at rest](#secrets-at-rest)),
  and runs smoke tests: the API, the webhook and the socket refuse what they
  should, and `notify` may make its directory calls (below).
- Last, it asks the hosting repository to build and deploy the app from the
  same commit (production: the release tag), and waits until the site serves
  it ([verifying.md](verifying.md), [hosting/](../hosting/README.md)). The
  request names the commit too, and the hosting repository refuses to build
  any other commit, one that isn't on `main` itself (not merged in from
  another branch), or one older than the live site's (unless asked to roll
  back: [hosting/](../hosting/README.md#rolling-back)). Before deploying
  anything, CI checks that the hosting repository's workflow takes that
  request.

Both environments run the same steps
([`deploy-environment.yml`](../.github/workflows/deploy-environment.yml)).

## Releases

Versions follow semantic versioning, with tags `vX.Y.Z`, and nothing about
them is done by hand:

1. Pull request titles follow Conventional Commits, and each squash merge to
   `main` keeps the title. [release-please](https://github.com/googleapis/release-please)
   reads them and keeps one release pull request open with the next version
   (`fix` → patch, `feat` → minor, `!` → major) and `CHANGELOG.md`. The
   current version is kept in `.release-please-manifest.json` and the tags.
   After every push to `main`, the release job also brings that pull
   request up to date with `main`, so it can always be merged. The release
   job runs only once dev has deployed the same commit: after a failed dev
   deploy, nothing is tagged until it is re-run and passes.
2. Merging that pull request is the decision to release. release-please then
   tags the merge commit (after dev has deployed it) and publishes a GitHub
   Release with the changelog.
3. The published release runs CI on the tag: everything is built and tested
   again from the tag, and the production deploy waits for a required
   reviewer's approval in GitHub. It checks that the tag points at the
   commit it deploys and that the commit is on `main` itself. The hosting
   repository builds the same tag, checked out as `refs/tags/vX.Y.Z`, after
   checking both again.

release-please acts through a GitHub App, because pull requests opened with
the workflow's own token get no CI, and releases it publishes start no
workflows. One-time setup:

- A GitHub App owned by the organization, with no webhook, installed on this
  repository only, with repository permissions Contents, Pull requests and
  Issues (for labels): read and write.
- A GitHub environment `release` that accepts `main` only, holding the app's
  client ID (variable `RELEASE_APP_CLIENT_ID`) and private key (secret
  `RELEASE_APP_PRIVATE_KEY`).
- A tag ruleset that lets only the release app create, move or delete
  `v*.*.*` tags, and a branch ruleset that forbids branches named `v*.*.*`.

## Setting up an environment

An account admin bootstraps an AWS account once (and reruns it to apply
changes to the bootstrap stack):

```shell
AWS_PROFILE=<profile> scripts/bootstrap.sh <aws-region> dev
AWS_PROFILE=<profile> DEPLOY_TAGS='v*.*.*' REVIEWERS=<login> scripts/bootstrap.sh <aws-region> production
```

It creates the Terraform state bucket, the GitHub OIDC provider, the deploy
role, the functions' roles and their permissions boundary, code signing, the
alerts below, and the [audit trail and change alerts](#audit-trail-and-change-alerts)
(`infra/init`), and the GitHub environment `<env>`, which accepts deploys from `main` only (dev)
or from release tags only, with required reviewers (production), with the
secrets and variables it computed (`AWS_ACCOUNT_ID`, `AWS_ROLE_ARN`,
`TF_STATE_BUCKET`, `LAMBDA_BUILDS_BUCKET`, `LAMBDA_SIGNING_PROFILE`,
`LAMBDA_CODE_SIGNING_CONFIG`, `AWS_REGION`). Then it asks IAM's policy
simulator whether the deploy role is denied what it should be
([below](#what-the-deploy-role-may-do)), and stops if not.

A rerun keeps the environment's required reviewers (unless `REVIEWERS`
names others) and its other protection settings: whether whoever started a
deploy may approve it, whether admins may skip the rules, and the wait
timer. It stops without changing anything if it can't read them (any error
but a 404, which means a new environment), and refuses to remove every
required reviewer unless `ALLOW_NO_REVIEWERS=1` is set.

The functions' execution roles (`<prefix>-fn-api`, `-bot`, `-ws` and
`-notify`, trusted by Lambda alone) belong to the bootstrap stack, so the
deploy role never creates a role or changes whom one trusts; the app stack
writes their policies. A new function needs its role added there
(`infra/init/main.tf`, `functions`) and applied first. In environments set
up before, the app stack created these roles: the bootstrap imports those
that exist instead of creating them (it passes them as
`existing_function_roles`), and the app stack's next deploy forgets them
without deleting them.

CI never changes `infra/init` (it can't change its own permissions). When a
change touches it, rerun the bootstrap in each environment before that
change deploys there. Each deploy checks this with IAM's policy simulator
(`scripts/check-function-roles.sh`), because a refused call between functions
would only log a warning: sends would still succeed while pushes and notices
stopped.

- Before applying anything, it asks whether the permissions boundary lets
  the existing roles make the invokes this code makes (`api` invoking `ws`
  and `notify`, `ws` invoking `notify`), as if the roles' own policies
  allowed them. Roles not created yet are skipped; the check after applying
  covers them.
- Before applying, it also asks whether the deploy role itself is denied
  what it should be, and allowed what the deploy does with the functions
  ([below](#what-the-deploy-role-may-do)), as the bootstrap does.
- After applying, it asks whether each function's role, its policy and the
  boundary together, allows every call the functions make to each other
  (those, and `ws` posting to sockets).

Each fails the deploy if a call isn't decided as it should be, or if the
deploy role may not ask (an older `infra/init`), and asks again a few times
when IAM is slow or throttles. Last, it reads each function's resource
policy, and fails if one lets anyone invoke the function whom the app stack
doesn't ([below](#what-the-deploy-role-may-do)).

The simulator can't check the conditions on `notify`'s directory access
(which items and attributes; [infra/functions.tf](../infra/functions.tf)),
so a smoke test does: it invokes `notify` with `{"check":{}}`, and the
function makes its directory read and both writes for a random account
that doesn't exist, under its role. A refusal fails the invocation and the
deploy; otherwise nothing changes. After a change to notices or that role,
check the rest by hand on dev: with the app closed, have a message sent to
you and get a notice; more than 4 minutes later, another message brings a
new notice, and the first is gone from the chat.

Code signing is a versioned bucket for the bundles, an AWS Signer profile,
and a code signing config set to enforce. Every function must use the config,
so Lambda runs only code signed by the profile. The deploy role can upload
and sign (any object it uploads: a signature shows that code came through
the deploy role, not what it was built from), but can't change the bucket's
settings, the profile or the config, nor create a function without the
config or remove it. If CI were ever compromised, an admin can revoke the
profile from a given time, after which Lambda refuses to deploy anything it
signed, and replace the profile by rerunning the bootstrap.

Alerts are a monthly cost budget (`MONTHLY_BUDGET=<dollars>` when
bootstrapping; 50 for production and 15 otherwise by default) and a few
alarms, all publishing to one SNS topic, `incognitochat-<env>-alerts`,
except the two on CloudFront and its firewall: their metrics are in
us-east-1, whatever the app's region, so they publish to a second topic
there, `incognitochat-<env>-edge-alerts`. The
[change alerts](#audit-trail-and-change-alerts) publish to the same two
topics.

| Alert | When |
|---|---|
| Budget | Half the budget is spent, all of it is, or the month is forecast to pass it. Billing data lags by hours. |
| `lambda-throttles` | Any function was refused for lack of concurrency. |
| `api-invocations` | The `api` function was called more than 30,000 times in 5 minutes (100 a second). |
| `api-errors` | The `api` function failed more than 10 times in 5 minutes. |
| `<table>-table-throttles` | A table refused requests because its per-second cap was reached. |
| `media-uploads`, `media-downloads` | The media bucket had more than 3,000 PUT or GET requests in 5 minutes (10 a second; `media_requests_alarm`). These go straight to S3, past the API and its alarms, and each is billed. They read the bucket's request metrics, which the app stack turns on. Those are billed like custom metrics, $0.30 a month each for up to 16, counted only in hours with requests: at most about $5 a month per environment. |
| `media-download-bytes` | More than 2 GiB was downloaded from the media bucket in 5 minutes (about 7 MB a second; `media_download_gib_alarm`). Downloads cost by the data sent: one 51 MiB download costs as much as about 11,000 GET requests. Same request metrics. |
| `media-stored` | The media bucket holds more than 50 GiB (`media_stored_gib_alarm`; about $1.15 a month). S3 measures it once a day, hours late, so this one is slow. The bootstrap finds the bucket by its name, so the alarm appears at the first bootstrap after the app stack's first deploy. |
| `bot-errors`, `notify-errors`, `ws-errors` | That function failed at all in 5 minutes (a crash, a timeout, or an error it returned to Lambda), or, for `notify` and `ws`, dropped an event after waiting a minute to run. Those two are invoked without waiting and never retried, so each is a lost notice or push. |
| `ws-client-errors`, `ws-integration-errors` | The WebSocket API counted more than 300 `ClientError`s (refused by API Gateway before `ws` ran: mostly its throttle) or `IntegrationError`s (refused or failed by `ws`) in 5 minutes (`ws_errors_alarm`, each alarm on its own). |
| `<table>-table-capacity` | A table used more than 70% of its read or write cap on average over 5 minutes (`table_capacity_alarm_percent`), before the cap refuses anyone. |
| `edge-5xx` (us-east-1) | More than 5% of CloudFront's answers were 5xx errors in each of three 5-minute periods in a row (`edge_5xx_rate_alarm`). |
| `firewall-blocks` (us-east-1) | The firewall blocked more than 3,000 requests in 5 minutes (10 a second; `firewall_blocks_alarm`). Only where `firewall` is true: by default in production alone. |
| `registrations` | More than 20 accounts were registered or set up again in an hour (`registrations_alarm`). |
| `token-requests` | More than 200 batches of send and media tokens were signed in an hour (`token_requests_alarm`). The app asks for 20 send tokens or 30 media tokens at a time. |
| `limit-hits` | The `api` function answered `429` (`rate_limited`, `daily_limit`, `link_busy` or `download_limit`, any route) more than 100 times in an hour (`limit_hits_alarm`). |
| `invalid-tokens`, `init-data-rejected`, `signature-rejected` | More than 50 requests in an hour were refused for that reason (`refusals_alarm`, each alarm on its own): a send or media token that isn't valid (`POST /send`, `POST /media`), Telegram data that doesn't check out (`POST /register`, `POST /accounts/lookup`, `POST /notices`), or a device signature that doesn't (registrations and every signed request). |

The last six read the `api` function's [request counts](#request-counts).
Their thresholds are guesses far above an early deployment's use: check
them against the metrics once real use has run a week or two, and set them
with `TF_VAR_<name>` when rerunning the bootstrap. The bootstrap doesn't
remember them: set each again at every rerun, or it goes back to its
default.

Three of the bootstrap's settings must match the app stack's, which it
can't read. Unset, each takes the same default by environment as there,
so they only need setting where the GitHub variable is set:
`table_max_read_units` and `table_max_write_units` (the capacity alarms'
thresholds come from them; `TABLE_MAX_READ_UNITS` and
`TABLE_MAX_WRITE_UNITS`), and `firewall` (whether the firewall's alarm
exists; true in production alone, while `FIREWALL` is on there). Set them
the same way, with `TF_VAR_<name>` at every rerun.

What to do when a media alarm fires (`media-stored` too):
[emergency switches](#emergency-switches). When a count alarm fires:
[request counts](#request-counts). When another fires:
[health alarms](#health-alarms).

The topics start without subscribers, so no address is stored in the
repository or in Terraform state. Subscribe one to each, and confirm the
emails AWS sends:

```shell
AWS_PROFILE=<profile> aws sns subscribe --region <aws-region> --protocol email \
  --topic-arn "$(terraform -chdir=infra/init output -raw alerts_topic_arn)" \
  --notification-endpoint <address>
# CloudFront's and the firewall's alarms, and changes to IAM, CloudFront
# and the firewall, in us-east-1.
AWS_PROFILE=<profile> aws sns subscribe --region us-east-1 --protocol email \
  --topic-arn "$(terraform -chdir=infra/init output -raw edge_alerts_topic_arn)" \
  --notification-endpoint <address>
```

CI can't change these alerts: they belong to the bootstrap stack. It can
still silence the six count alarms, though, since it deploys what they
read: the log line, the metric filters and the log level. Once the
bootstrap stack is applied with the deny on table items (added with the
[emergency switches](#emergency-switches); apply it in each environment), CI
can't write table items either, so a deploy can't overwrite runtime data
such as the switches.

Then set the rest:

```shell
gh secret set BOT_TOKEN --env <env>
gh variable set CLIENT_ORIGINS --env <env> --body '["https://<org>.github.io"]'
```

| Name | Kind | What |
|---|---|---|
| `BOT_TOKEN` | secret | The bot's token from BotFather. Raise `BOT_TOKEN_VERSION` to push a changed token. |
| `ISSUER_KEY` | secret | The send-token issuer's private key (below). Raise `ISSUER_KEY_VERSION` when it changes. |
| `MEDIA_ISSUER_KEY` | secret | The media-token issuer's private key (below), a different key. Raise `MEDIA_ISSUER_KEY_VERSION` when it changes. |
| `PREVIOUS_ISSUER_KEY`, `PREVIOUS_MEDIA_ISSUER_KEY` | secrets | Unset except while an issuer key is being replaced: the key it replaces, still held so that open apps keep working ([rotating an issuer key](#rotating-an-issuer-key)). Raise `PREVIOUS_ISSUER_KEY_VERSION` or `PREVIOUS_MEDIA_ISSUER_KEY_VERSION` (variables, 1 while unset) whenever one is set or deleted. |
| `DROP_LIVE_ISSUER_KEY` | variable | Unset except for the deploy after a key leaks: `true` lets it drop a key the live site still names ([rotating an issuer key](#rotating-an-issuer-key)). |
| `ADMIN_TELEGRAM_IDS` | secret | Comma-separated Telegram user IDs of admins. A secret, so the IDs stay out of the public deploy logs. They reach the `api` function as a plain environment variable, so they're also in Terraform state, and anyone who can read the function's configuration can read them; the API recognises admins by their keyed hashes. |
| `CLIENT_ORIGINS` | variable | Origins allowed to call the API from a browser: the app's `https://<org>.github.io`. |
| `INVITE_ONLY` | variable | `true` by default: only accounts that joined through an invitation, and admins, can own links. |
| `RESERVE_CONCURRENCY` | variable | `true` gives each function its own share of the account's concurrent executions (`api` 100, `ws` 20, `notify` 10, `bot` 5), so a flood on one can't starve the others. Off by default: it needs a Lambda concurrency quota of at least 235 in the account (new accounts start at 10; ask for more in Service Quotas). |
| `API_ACCESS` | variable | How the app reaches the API (below): `direct` (default), `cloudfront` or `cloudfront-only`. |
| `FIREWALL` | variable | `true` puts a firewall (AWS WAF) in front of CloudFront, with three rate limits and a list of addresses to block ([below](#the-firewall)). Off by default: about $9 a month, plus $0.60 per million requests. The bootstrap's `firewall` must match where it differs from production's default (on there alone). |
| `DELETION_PROTECTION` | variable | Protects the tables from deletion. Keep it on in production. |
| `SESSION_KEY_VERSION`, `WEBHOOK_SECRET_VERSION`, `CHAT_KEY_VERSION`, `TELEGRAM_ID_PEPPER_VERSION` | variables | Unset by default (1). Raise one to replace that generated secret alone: [what each does](#replacing-a-generated-secret). The pepper's is only for starting over. Keep a raised version set: deleting it means 1, which replaces the secret again. |
| `SECRETS_VERSION` | variable | Retired: leave it unset, or the deploy stops ([below](#replacing-a-generated-secret)). |
| `PAGES_REPO`, `PAGES_URL` | variables | The hosting repository and the site's address, for starting its deploy and waiting for it. |
| `PAGES_DISPATCH_TOKEN` | secret | A token for the hosting repository's Actions, to start its workflow. It can't change that repository's files or settings, but it can also start the workflow with any inputs, re-run, cancel and delete its runs, and turn it off ([hosting/](../hosting/README.md#setting-up-a-hosting-repository)). |

The limits below can be tuned without a code change, but none needs
setting: unset, each takes its default from
[`infra/variables.tf`](../infra/variables.tf), and where an environment
needs other values, the defaults depend on its name (`production`, or
anything else), so an environment comes from the repository alone.

| Name | Default | What |
|---|---|---|
| `TABLE_MAX_READ_UNITS`, `TABLE_MAX_WRITE_UNITS` | 400 and 200 in production, 200 and 100 elsewhere; at most 3,000 and 1,000 | Each table's cap on read and write request units a second ([cost guards](#cost-guards)). Elsewhere is lower: dev has no firewall and a small budget. At most 3,000 and 1,000, what one partition can take: sends to mailboxes that don't exist all read and write the same few placeholder items, which must not be throttled before the table is. Where set, set the bootstrap's `table_max_read_units` and `table_max_write_units` the same, for its capacity alarms. |
| `FIREWALL_RATE_LIMIT` | 2,000 | Requests one IP address may make in 5 minutes, to any route (`rate-per-ip`). |
| `FIREWALL_ANONYMOUS_RATE_LIMIT` | 500 | Requests one IP address may make in 5 minutes to the routes that need no login (`anonymous-per-ip`). At most `FIREWALL_RATE_LIMIT`. |
| `FIREWALL_LOOKUPS_TOTAL_LIMIT` | 30 times the read cap: 12,000 in production | Lookups of links and uploads by ID everyone together may make in 1 minute (`lookups-total`). At most 30 times the read cap, so it follows the caps when unset. |
| `WS_THROTTLE_RATE_LIMIT`, `WS_THROTTLE_BURST_LIMIT` | 20, 40 | The WebSocket API's throttle, shared by everyone: requests a second, and the burst. At least 1. |
| `LOG_RETENTION_DAYS` | 7 | Days the functions' logs are kept. One of the periods CloudWatch Logs takes (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, and longer ones up to 3653); never 0, which keeps them forever. [What the software stores](data.md) tells people 7 days: change it there before keeping them longer. |

A change takes effect at the environment's next deploy: for dev, the next
push to `main` or a manual run of CI on `main`; for production, the next
release, or a re-run of the latest release's CI run in GitHub Actions
(possible for 30 days; a re-run reads the variables afresh and waits for the
reviewer's approval again). A value outside its bounds fails the deploy at
Terraform's plan, before anything changes. Changing a firewall limit
restarts that rule's counts, so it may not block for up to a minute.

### The token issuer keys

Sends are paid with anonymous send tokens and uploads with media tokens,
each signed by an issuer key of its own: two RSA-2048 private keys kept only
as secrets (`ISSUER_KEY` and `MEDIA_ISSUER_KEY`). They must differ, since a
key is what gives a kind of token its own daily budget. Their public keys
are published in [`web/issuer-keys.json`](../web/issuer-keys.json), and an
app build accepts only the keys its build names, so the server can't give
users different keys. For each key:

```shell
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out issuer.pem
openssl pkey -in issuer.pem -pubout -outform DER | basenc -w0 --base64url  # the "spki" to publish
gh secret set ISSUER_KEY --env <env> < issuer.pem && shred -u issuer.pem  # or MEDIA_ISSUER_KEY
```

Add the send key to `web/issuer-keys.json` under a new name with its `keyId`
(the SHA-256 of the DER), the media key under `media` in the same entry, and
set the hosting repository's `ISSUER_KEY` variable to that name. Every
deploy checks the keys, before it changes anything and after
([what each deploy checks](#rotating-an-issuer-key)). To replace a key
later: [rotating an issuer key](#rotating-an-issuer-key).

### The bot

In BotFather, for the environment's bot:

- a direct-link Mini App `<app>` pointing at `https://<org>.github.io/`,
  with "request write access" on;
- the main Mini App and the menu button pointing at the same address;
- a privacy policy, which Telegram's bot developer terms require. Whoever
  runs the environment publishes it, outside this repository;
  [data.md](data.md) is the technical part it can point to.

### The app's hosting

The app is served from `<org>/<org>.github.io` in a GitHub organization of its
own. How to create and configure it, and the variables it needs (`API_URL`,
`WS_URL`, `MEDIA_ORIGIN` from Terraform's outputs, `BOT_USERNAME`,
`APP_NAME`, `ISSUER_KEY`), is in [hosting/README.md](../hosting/README.md).

### What the deploy role may do

The deploy role ([`infra/init/github_deploy.tf`](../infra/init/github_deploy.tf))
may make only the calls the app stack's Terraform makes, on the app stack's
own resources. What a deploy never needs is denied outright (the
`<prefix>-github-deploy-limits` and `-github-deploy-no-items` policies), so
that a compromised deploy job, or a deploy someone got approved, can't read
user data itself, and most ways to leave access behind that no Terraform
plan would show are closed. What IAM can't close is listed below, and in
[security.md](security.md#other-limits).

- **Tables**: it manages them, but can't read or write their items, scan,
  query, export, back up or restore them, stream their changes, or give
  them a resource policy. It can still change their capacity (`UpdateTable`
  has no condition keys): a change shows in the next plan, which undoes it,
  but costs until then.
- **Functions**: it deploys signed code and changes their settings. It
  invokes only `bot` (setting it up) and `notify` (its check), creates no
  other function, gives URLs only to `api` and `bot`, and buys no
  provisioned concurrency.
- **Function permissions** (who may invoke a function): it may name only
  anyone ("*", on `api` and `bot`, for their URLs, and never for a URL that
  needs AWS's signature), CloudFront (on `api`) and API Gateway (on `ws`);
  no account or role. IAM can't check more than that. A permission for anyone can't be
  told from one for calls through the URL alone, so it could let anyone
  invoke `api` or `bot` directly, with any event. And AddPermission has no
  condition key for the source, so it could let another account's
  distribution invoke `api`, or another account's API invoke `ws`. So each
  deploy, after applying, reads every function's resource policy and fails
  on any statement the app stack doesn't set, as it sets it, with
  CloudFront and API Gateway limited to this stack's distribution and API,
  and anyone limited to `bot`, and to `api` while its URL needs no auth
  (`scripts/check-function-roles.sh policies`; see also
  [what the AWS provider leaves](#cloudfront-in-front-of-the-api)). Such a
  statement lasts until the next deploy finds it; remove it as an admin
  with `aws lambda remove-permission`.
- **Roles**: it may only write the four functions' roles' own policies,
  which the permissions boundary caps, and pass those roles to Lambda. It
  can't create a role, user or access key, change whom a role trusts, or
  attach a policy, its own roles' included.
- **Logs**: it manages the functions' log groups and the metric filters on
  them, but can't read them, subscribe to them or export them.
- **The media bucket**: it manages only the settings `infra/media.tf` sets,
  so a change to any of them shows in the next plan, which undoes it. It
  can't turn on versions, notifications, request logs, replication or
  inventories, nor read, write or delete attachments.
- **Parameters**: it writes them, and reads their values: the AWS provider
  reads every parameter it manages, decrypted, on each plan, write-only ones
  too. That takes `GetParameter`, which also reads older versions
  (`<name>:<version>`) on the same ARN, with no condition key to refuse
  them, for as long as the parameter keeps them (its last 100). It can't
  list their history, read them all by path, or share them. After a leak,
  [delete the parameter](#replacing-a-generated-secret) to drop its history.
- **The WebSocket API**: it manages it, and IAM can't limit which routes,
  integrations or other APIs it adds. Nothing checks these yet.
- **The edge**: it manages CloudFront distributions, origin access controls
  and origin request policies (their IDs are random, so IAM can't tell the
  stack's own from others in the account; creating an origin request
  policy can't be limited at all), and, in us-east-1, the firewall's web
  ACLs and IP sets named with the prefix. A web ACL's rules may use only
  those IP sets. It can read and change the addresses in them, as it can
  change the rules.
- **The audit trail**: it can't call CloudTrail at all (stop, change or
  delete the trail, or make another), nor touch the trail's bucket, its
  settings or the records in it
  ([audit trail and change alerts](#audit-trail-and-change-alerts)).

The bootstrap and every deploy check the denies and the calls the deploy
needs with IAM's policy simulator (`scripts/check-function-roles.sh
deploy-role`), printing each check.

**Applying the change that brought this** (the functions' roles moving to
`infra/init`, and the denies), in each environment in turn, dev first:

1. Rerun the bootstrap, while no deploy runs. Its plan should import the
   four roles and change nothing in them (no role created or destroyed),
   add the `-github-deploy-functions` and `-github-deploy-limits` policies
   and narrow `-github-deploy`; then every simulator check should pass. A
   deploy from before the change still works with it: its plan finds
   nothing to change in the roles.
2. Deploy the change (dev: merge it; production: release it). Its plan
   should say the four `aws_iam_role.fn` "will no longer be managed by
   Terraform" and destroy nothing, and the deploy's own checks should pass.
   A deploy of the change against a bootstrap from before it stops at the
   deploy role's check, before applying anything. If the resource policies'
   check fails on a statement left from long ago, remove it as an admin
   (or, if it is one this stack should set, fix the check).

## Secrets at rest

Secrets are SSM parameters written through Terraform's write-only
arguments, so they never land in Terraform state or plans: the bot token and
the two issuer keys (and, while a rotation lasts, the keys they replaced;
otherwise those parameters hold `none`), from the environment's secrets, and four that Terraform
generates, the session key, the webhook secret, the chat key (which seals
chat IDs) and the Telegram-ID pepper. Each function's role can read only the
parameters it needs: only `bot` and `notify` can read the bot token.

They do pass through CI. Every deploy hands the bot token and the issuer
keys to its checks and to Terraform's plan and apply, though Terraform
writes each to SSM only when its version rises, and Terraform makes the
generated secrets on the runner. The deploy role can also read each of
them from SSM ([what it may do](#what-the-deploy-role-may-do)).

Each new instance of a function reads its parameters once, as it starts.
SSM serves an account 40 such calls a second by default, so when many
instances start at once (a deploy, a sudden rise in use) some are
throttled: a function tries each call up to 5 times, after random waits
that grow, within 4 seconds, before it gives up (and the request that
started it fails).

### Replacing a generated secret

Each generated secret has a version of its own, a variable of the
environment that is 1 while unset. Raise one, and the environment's next
deploy (for dev, the next push to `main`; for production, the next release,
or a re-run of the latest release's CI run if that release includes these
versions, below) writes a new random value for that secret alone and
restarts the functions that read it; the other secrets keep theirs. For
example:

```shell
gh variable set SESSION_KEY_VERSION --env <env> --body 2
```

A version only says when to write a new value: any change writes one,
never an old one. Raise it again (3, 4…) to replace the secret again. Keep
a raised version set. Deleting it means 1, which replaces the secret again,
as lowering it does.

**After a leak**, replacing a secret leaves its old value readable: SSM
keeps a parameter's last 100 versions, and whoever may read the parameter
can read an older one by number (`<name>:<version>`): the functions that use
it, and the deploy role, since Terraform reads every parameter it manages.
To drop them, delete the parameter as an admin right before the deploy that
replaces the secret; the deploy finds it gone and creates it again, with
the new value and no history. For example, for the chat key (the bot token
and the issuer keys work the same, with their secrets changed first):

```shell
gh variable set CHAT_KEY_VERSION --env <env> --body 3   # one above its current version
AWS_PROFILE=<profile> aws ssm delete-parameter --region <aws-region> \
  --name /incognitochat/<env>/chat-key
```

Then deploy at once, as for any version change. Until the deploy has
written the parameter again, a function instance that starts can't read it
and its requests fail; warm instances keep the old value until the deploy
replaces them. Never for the pepper: its old value, from the history, is
the only way back (below).

Only a release that includes these versions reads them; one from before
them reads only `SECRETS_VERSION`. So in production a raised version takes
effect only with a release that includes them, and re-running an older
release's CI run doesn't apply it. Once one has taken effect, never re-run
an older release's CI run: it sets every generated secret's version back to
1, which replaces each raised one again, the pepper too.

| Secret | Version | Read by | What replacing it does |
|---|---|---|---|
| Session key | `SESSION_KEY_VERSION` | `api`, `ws` | Every session ends, and apps log in again by themselves with their device keys. Socket records are named with a key derived from it, so until open apps replace their sockets (within about half an hour) they get no pushes: they see new messages at their next poll, within about 2 minutes, and accounts with notices on get a Telegram notice too. The old records expire within 40 minutes. Replace it if it may have leaked: it can make a session for any account. |
| Webhook secret | `WEBHOOK_SECRET_VERSION` | `bot` | The same deploy registers the webhook again with the new secret when it sets up the bot, right after checking what it deployed and before the smoke tests. Updates Telegram sends in the minute or so between are refused, and Telegram sends them again. If a deploy stops before setting up the bot, the bot refuses every update: run the deploy again. Nothing for users to do. |
| Chat key | `CHAT_KEY_VERSION` | `notify` | The sealed chat IDs no longer open. Each account's next notice isn't sent and turns its notices off. The app turns them on again by itself the next time the user opens it other than through a link or an invitation, if the bot may still write to them (otherwise it offers to turn them on). Until then the account gets no notices, so users who wait for one must open the app once. The 3-minute gaps between notices start afresh. |
| Telegram-ID pepper | `TELEGRAM_ID_PEPPER_VERSION` | `api` | Only to start over (below). Undone only by hand. |

**The pepper is only for starting over.** Each account's Telegram user is
kept as a keyed hash under the pepper, never as the ID, and no stored hash
matches a new pepper. Existing accounts keep working (logging in, links,
sending and receiving don't use the pepper), but for every one of them:

- Notices can never be turned on again: setting them up checks the launch's
  Telegram user against the stored hash, and is refused (401) for good.
  Notices that are on stay on until they go off (the user blocks the bot, or
  the chat key changes).
- Admins lose admin: `ADMIN_TELEGRAM_IDS` are hashed with the new pepper, so
  they match no existing account.
- One account per Telegram user no longer holds: a user who sets the app up
  again (a new device, or after clearing its data) gets a second account
  instead of replacing the first, which stays live with its links. The
  check for an account on another device finds nothing.
- Every rate limit starts afresh for its minute, hour or day (counters are
  named with the pepper), including those per Telegram user.
- Inbox item IDs carry a code keyed with the pepper: confirming messages
  listed just before the change is refused once (400), and works again
  after the app lists its inbox again.

Terraform can't write the old value back. SSM keeps a parameter's last 100
versions, so an admin can still restore it by hand: read the old value from
the parameter's history, write it back, and make `api` start new instances
(any change to its configuration does), keeping the raised version set.
Accounts set up in the meantime then break the same way, under the pepper
they were set up with.

`SECRETS_VERSION` once replaced all four at once, the pepper included. It is
retired, and the deploy stops if it is set, as a variable of the
environment, the repository or the organization. If it is 1, deleting it is
enough. Otherwise set the four versions above to its value first, so that
nothing is replaced, then delete it.

### Rotating an issuer key

Replacing an issuer key is the only way to make the tokens already handed
out worthless: after the key leaks, or to void tokens someone has stockpiled.
Each kind (send, media) can be replaced on its own.

The API holds each kind's current key (`ISSUER_KEY`, `MEDIA_ISSUER_KEY`)
and, while a rotation lasts, the key it replaced (`PREVIOUS_ISSUER_KEY`,
`PREVIOUS_MEDIA_ISSUER_KEY`). It accepts tokens of both, and signs each
batch with the key the app asks for: the one its build names. An app counts
and spends only its own key's tokens; it leaves others alone, for a copy of
the app on the other build, until they expire. So apps still open on the
old build keep working while the site switches, and an app on the new build
never spends old-key tokens. An app whose key the API no longer holds can't
get tokens, but isn't charged for asking, and its tokens are refused as a
retired key's: it tells the user to close it and open it again
([protocol](protocol.md#send-tokens-and-media-tokens)).

A rotation has a cost to privacy ([security.md](security.md)): while both
keys are held, the server sees which accounts still fetch tokens for the old
key, and every old-key token it is paid with comes from one of them. Keep
the window short.

Each of these secrets has a version variable (`ISSUER_KEY_VERSION`,
`PREVIOUS_ISSUER_KEY_VERSION`, and the same for media; 1 while unset). A
deploy writes a secret into SSM, and restarts `api`, only when its version
changes, so raise the version with every change, deleting a secret too.
With no previous key set, nothing changes: the API holds the current keys
alone. A deploy for production is a release, or a re-run of the latest
release's CI run (which reads the secrets and variables afresh); for dev, a
push to `main` or a run of CI on `main`.

**The usual rotation.** The order matters: the API holds both keys before
the site switches, and the old key goes only once the site is live.

1. Make the new key and publish it: the first two commands in [the token
   issuer keys](#the-token-issuer-keys), not the secret yet, and its
   `keyId` from `openssl pkey -in issuer.pem -pubout -outform DER |
   sha256sum`. Add a new entry to
   [`web/issuer-keys.json`](../web/issuer-keys.json), named
   `<env>-<year>-<month>`, with the new key and the other kind's current
   key (an entry names both kinds; the kind not being replaced keeps its
   key, which entries of one environment may share). Merge it, and for
   production, release it. Nothing changes yet: the site still names the
   old entry. Keep the new private key for step 2.
2. Hold both keys and switch the site, in one deploy. The current key is
   only in SSM (a secret can't be read back), so read it from there with
   an admin profile. Set the secrets and their versions first, the previous
   key before the new one:

   ```shell
   AWS_PROFILE=<profile> aws ssm get-parameter --region <aws-region> --with-decryption \
     --name /incognitochat/<env>/issuer-key --query Parameter.Value --output text > previous.pem
   gh secret set PREVIOUS_ISSUER_KEY --env <env> < previous.pem && shred -u previous.pem
   gh variable set PREVIOUS_ISSUER_KEY_VERSION --env <env> --body <its value + 1>
   gh secret set ISSUER_KEY --env <env> < issuer.pem && shred -u issuer.pem
   gh variable set ISSUER_KEY_VERSION --env <env> --body <its value + 1>
   ```

   (For the media key: `media-issuer-key`, `PREVIOUS_MEDIA_ISSUER_KEY`,
   `MEDIA_ISSUER_KEY` and their versions.) Only then set the hosting
   repository's `ISSUER_KEY` variable to the new entry's name, and deploy.
   Dev deploys at every push to `main`, so in this order a deploy that
   starts in between never builds the site for a key the API doesn't hold
   yet. The deploy applies the backend first, then has the site built, so
   the new build only goes live once the API holds its key. If the site
   still names the previous keys once it is live, the deploy warns.
3. Retire the old key once the site serves the new build (the deploy waits
   for it), and at least 10 minutes after that, for GitHub Pages' cache:
   delete `PREVIOUS_ISSUER_KEY`, raise `PREVIOUS_ISSUER_KEY_VERSION` again,
   and deploy. Until then the old key's tokens, stockpiled ones too, are
   still accepted, so for a stockpile retire it as soon as that allows.
   Apps still open on the old build then can't send until they are opened
   again. The deploy refuses to drop a key the live site still names.

**After a leak.** Don't hold the leaked key at all: anyone with it can make
tokens. Make and publish the new key as in step 1 (or use a standby entry,
below). Then set `ISSUER_KEY` to it and raise its version, leave
`PREVIOUS_ISSUER_KEY` unset (delete it, and raise its version, if an earlier
rotation left one), set the variable `DROP_LIVE_ISSUER_KEY` to `true` (the
deploy otherwise refuses to drop the key the live site names), set the
hosting variable to the new entry, and deploy. Delete
`DROP_LIVE_ISSUER_KEY` afterwards (the next deploy warns while it is set).
The leaked key's tokens are refused from the moment the backend is applied.
Until the site is live (5 to 20 minutes) and each user opens the app again,
apps on the old build can't send or upload. They aren't charged for trying,
and they tell the user to close the app and open it again.

**A standby entry** makes a rotation after a leak faster: no pull request
or release first. Make the next keys ahead of time, publish them as an
entry of their own that no site names yet, and keep their private keys
offline (not in GitHub or AWS, where a leak of the current key might reach
them too). A rotation then starts at step 2 with the latest release. The
entry has a new key of each kind, so using it replaces both; the kind that
didn't leak can keep its old key as the previous one, as in step 2.

**What each deploy checks.** Before it changes anything: that each key is
an RSA-2048 key the API can load, that no two of them are the same key,
that the current keys are published together in one entry, and that the
keys the live site names stay held (unless `DROP_LIVE_ISSUER_KEY`). After
applying, it asks the API which keys it holds (`GET /tokens/keys`, public)
and fails unless they are the secrets' keys, current first: a secret
changed without raising its version never reaches the API. Once the site
is live, that the keys its entry names are held. A re-run of a release
from before these settings drops the previous keys.

## Cost guards

The tables are on-demand, each capped at 400 read and 200 write request
units a second in production, and at 200 and 100 in any other environment
(`TABLE_MAX_READ_UNITS`, `TABLE_MAX_WRITE_UNITS`). Past a cap a table
refuses requests, which cost nothing, and its `<table>-table-throttles`
alarm fires. The functions then fail such calls fast (two tries, at most
200 ms apart), the API answers `503 unavailable` with `Retry-After`, and
apps back off their background syncs
([protocol.md](protocol.md#registration-and-sessions), Overload). The caps bound the tables' bill. At eu-west-1's on-demand
prices ($0.1415 per million read units, $0.705 per million write units):

| | One table at both caps, a day | All three, a day |
|---|---|---|
| Production (400, 200) | about $17 ($4.89 reads, $12.18 writes) | about **$51** ($2.13 an hour), about production's default monthly budget ($50) every day |
| Elsewhere (200, 100) | about $8.50 ($2.45 reads, $6.09 writes) | about **$26** ($1.07 an hour), about 2.5 times dev's default monthly budget ($10) every day |

The throttle alarms fire as soon as a table refuses requests; the budget's
within a day, since billing data lags by hours.

The caps are also the service's ceiling: every logged-in request reads the
directory (one unit), and every small delivered message takes about three
write units on the ephemeral table, so production's caps carry at most
about 400 logged-in requests and 66 messages a second, and other
environments' half that (fewer large messages: they cost more send tokens,
and storing an envelope takes a write unit per KB on the messages table).
Watch each table's `ConsumedReadCapacityUnits` and
`ConsumedWriteCapacityUnits` (namespace AWS/DynamoDB, dimension TableName,
`<prefix>-<table>`; the sum over a minute divided by 60 is the rate; the
`<table>-table-capacity` alarms fire past 70% of a cap). Raise the caps
once real use regularly passes half of them; unless
`FIREWALL_LOOKUPS_TOTAL_LIMIT` is set, the firewall's limit on lookups
follows ([the firewall](#the-firewall)).

The WebSocket API is throttled (`WS_THROTTLE_RATE_LIMIT`,
`WS_THROTTLE_BURST_LIMIT`), and nothing runs when idle. Logs are kept 7
days (`LOG_RETENTION_DAYS`). A budget and alarms watch the account, and
each function can be given its own share of concurrency
(`RESERVE_CONCURRENCY`), both above.

## Emergency switches

Two switches pause attachments for everyone without a release: **uploads**
(no new upload URLs: `POST /media` and `POST /media/{id}/upload` answer
`503 uploads_paused`) and **downloads** (no new download URLs: `GET
/media/{id}` answers `503 downloads_paused`). `POST /media` answers before
any media token is looked at, and `GET /media/{id}` before the download is
counted. `POST /media/{id}/upload` still checks the bucket first, so an
upload that was written (only its answer lost) is still done, and refuses
only the fresh URL, which counts as one of the upload's three. The one loss:
a pause that lands between paying for an upload and a PUT that fails costs
those tokens, since the app's Try again pays again. Messages, reactions and
everything else keep working. The app says "Attachments are paused for now; try again later",
keeps an unsent attachment as Not sent with Try again in its menu, and stops
fetching attachments by itself for two minutes at a time.

They are one item in the directory table, pk `S#switches`, sk `S`, with BOOL
attributes `uploadsPaused` and `downloadsPaused`. No item, a missing
attribute, or anything but BOOL true means not paused. Each `api` instance
reads it at most every 30 seconds, and only when a media route is called. If
a read fails, the instance keeps what it last read and reads again 5 seconds
later. An instance that has never read it counts both as paused, so failing
the directory's reads can't get past a pause; the app takes the few seconds
of refusals in its stride. A value of the wrong type (say `{"S":"true"}`)
pauses nothing, and each instance logs "a switch isn't a BOOL" once.
Terraform doesn't manage the item, and once the bootstrap stack is applied
the deploy role is denied writing table items, so deploys never reset it.

**When a media alarm fires** (`media-uploads`, `media-downloads`,
`media-download-bytes`):

1. Look at the bucket's request metrics in CloudWatch (namespace AWS/S3,
   dimensions BucketName and FilterId, filter `<prefix>-media`, where
   `<prefix>` is `incognitochat-<env>`): `PutRequests`, `GetRequests`,
   `BytesDownloaded` and `4xxErrors`, a minute at a time. Real use rises and
   falls with the `api` function's invocations. A URL being replayed is a
   flat, high rate: for uploads mostly `4xxErrors` (refused requests are
   billed too), for downloads data far beyond what the users could fetch.
2. If it isn't clearly real use and it lasts longer than one alarm period,
   pause the side it's on. At today's prices a replayed upload URL can cost
   about $1,500 a day and 2 GiB of downloads every 5 minutes about $50 a
   day, while a pause only holds attachments back for a while.
3. Pause with the AWS CLI (an admin profile of the environment's AWS
   account), or from the app: Link tab, Admin, Attachments (admins only;
   it asks to confirm).

   ```shell
   export AWS_PROFILE=<profile> AWS_REGION=<aws-region>
   table=<prefix>-directory key='{"pk":{"S":"S#switches"},"sk":{"S":"S"}}'
   # Pause uploads (for downloads: downloadsPaused). :p false resumes.
   aws dynamodb update-item --table-name "$table" --key "$key" \
     --update-expression 'SET uploadsPaused = :p' \
     --expression-attribute-values '{":p":{"BOOL":true}}'
   # Or set both at once.
   aws dynamodb put-item --table-name "$table" --item \
     '{"pk":{"S":"S#switches"},"sk":{"S":"S"},"uploadsPaused":{"BOOL":true},"downloadsPaused":{"BOOL":false}}'
   # What is set now.
   aws dynamodb get-item --table-name "$table" --key "$key" --consistent-read
   ```

4. Check that it took effect. Within half a minute the API answers so
   (`<api-url>` is the site's `API_URL`, ending in `/`), and each `api`
   instance logs "uploads paused" or "downloads paused" once:

   ```shell
   curl -s '<api-url>media/AAAAAAAAAAAAAAAAAAAAAA'   # downloads_paused, else not_found
   curl -s -X POST '<api-url>media' -H 'Content-Type: application/json' \
     -H 'X-Amz-Content-Sha256: 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' \
     -d '{}'                                          # uploads_paused, else bad_request
   ```

   URLs given out just before still work for up to a minute (S3 refuses
   any older), and the metrics lag a minute or two, so the request rate
   should drop within about three minutes. If it doesn't, the requests
   aren't coming from URLs the API gives out: look elsewhere.
5. Undo the same way, with `false` (or Resume in the app), once the cause is
   dealt with or the alarm has stayed quiet. Apps fetch by themselves again
   the next time a chat opens, at most two minutes after their last refused
   try; an unsent attachment goes with Try again.

The switches aren't flipped automatically by the alarms.

## Request counts

The `api` function keeps no access log, but each instance counts the
answers it gives and logs the counts once a minute, in one line. It is
logged as a warning, since production keeps only warnings and errors; it
isn't one.

```json
{"time":"2026-11-18T10:02:00Z","level":"WARN","msg":"request counts","fn":"api","count":44,
 "errors":{"rate_limited":2,"signature_rejected":1},
 "routes":{"get_inbox_200":12,"post_register_200":1,"post_send_200":28,"post_send_429":2,"put_links_id_keys_401":1}}
```

- `count` is every answer in that minute, `routes` the answers by route
  pattern and status (`PUT /links/{id}/keys` with 401 is
  `put_links_id_keys_401`), and `errors` the error answers by code, all
  routes together. Requests to no route, and requests Lambda refuses
  (`lambda-throttles`), aren't counted.
- Counts only: route patterns, never paths (which carry IDs), statuses and
  error codes. Nothing names a person, device, account, link, mailbox,
  address or request.
- `time` is the start of the minute counted. Lambda freezes an instance
  between requests, so the line is written with the instance's first
  request after that minute, or when the instance shuts down, which Lambda
  may do long after the instance's last request. An idle instance writes
  nothing.

Metric filters on the `api` log group (`infra/metrics.tf`, in the app
stack) make these metrics of the lines, in namespace `<prefix>/api`. Each
data point is dated by when its line was written, not by its `time`. The
alarms on them (above) are in the bootstrap stack, which CI can't change,
but CI deploys the line, the filters and the log level, so it could still
silence them. A test (`backend/internal/tally`) checks that every name the
filters read is one the `api` function can log.

After the first deploy with these filters, once the app has been used
(a metric appears only when it first counts something), check that the
metrics are there:

```shell
AWS_PROFILE=<profile> aws cloudwatch list-metrics --region <aws-region> --namespace <prefix>/api
```

| Metric | Counts |
|---|---|
| `Registrations` | Successful `POST /register`: new accounts, accounts set up again, and registrations retried after a lost answer. |
| `SendTokenRequests`, `MediaTokenRequests` | Successful `POST /tokens` and `POST /tokens/media`: batches of tokens signed. |
| `Limited` | Every `429` (`rate_limited`, `daily_limit`, `link_busy`, `download_limit`). |
| `Limited.<route>` | One route's `429`s, e.g. `Limited.post_send`, for each route with a limit (`local.limited_routes`). |
| `InvalidToken`, `InitDataRejected`, `SignatureRejected` | Answers with that error code. |

Metric filters are free. Each of the 19 metrics is billed as a custom
metric, $0.30 a month, but only for the hours it gets data: about $1 a month
for the three counted whenever the app is used, next to nothing for the
others until something goes wrong, and at most $5.70 if all of them got data
every hour. The six alarms cost $0.70 a month (the token alarm reads two
metrics), and the lines, under 1 KB a minute per busy instance, cents. So
about $2 a month per environment, at most about $6.50.

**When a count alarm fires:**

1. Look at the metric over the last day or two (CloudWatch, namespace
   `<prefix>/api`), and at the lines themselves, in Logs Insights on
   `/aws/lambda/<prefix>-api`, an hour at a time:

   ```
   filter msg = "request counts"
   | stats sum(`routes.post_register_200`) as registrations,
           sum(`routes.post_tokens_200`) as send_batches,
           sum(`routes.post_send_200`) as sends,
           sum(`errors.rate_limited`) as rate_limited,
           sum(`errors.daily_limit`) as daily_limit,
           sum(`errors.link_busy`) as link_busy,
           sum(`errors.download_limit`) as download_limit
     by bin(1h)
   ```

   `bin(1h)` goes by `@timestamp`, when each line was written, not by the
   minute in its `time`, so a few counts can land in the next hour. Or read
   the lines of the minutes that matter (`filter msg = "request counts" and
   (errors.rate_limited > 0 or errors.daily_limit > 0 or errors.link_busy > 0
   or errors.download_limit > 0)`): `routes` shows where. The four codes are
   every `429` the `api` answers, which `Limited` adds up.
2. `registrations`, `token-requests`: real growth (a post that shares the
   bot, say) comes with more of everything, sends and inbox fetches
   included. A campaign of many accounts, each within its own limits, shows
   as registrations at a steady rate, then token batches growing with them
   while sends don't keep up. If it isn't real use, see what it costs (the
   budget, the tables' consumed capacity) and how fast it grows. Each
   account stays within its limits, and keeping `INVITE_ONLY` on keeps new
   accounts from owning links; nothing stops registrations without a
   release.
3. `limit-hits`: `Limited.<route>` says which limit. A rise on one route
   without more traffic is someone pushing at that limit, which is holding;
   a rise with more traffic everywhere is real use outgrowing the limits.
4. `invalid-tokens`: forged, replayed or out-of-date tokens on `POST /send`
   or `POST /media` (`routes` says which).
5. `init-data-rejected`, `signature-rejected`: Telegram data or device
   signatures that don't check out: forged, out of date, or (signatures) a
   signed request sent again, since each is good once. A device whose clock
   is off is answered `clock_skew` instead. With an `api-invocations` alarm
   too, it's a flood: see [the firewall](#the-firewall).

## Health alarms

The alarms on the other functions, the WebSocket API, the tables' capacity
and the edge ([above](#setting-up-an-environment); `infra/init/alerts.tf`).
Each costs $0.10 a month per metric it reads: about $1.60 a month for
these in production, $1.50 elsewhere. The functions' logs, in Logs Insights
on `/aws/lambda/<prefix>-<function>`, keep warnings and errors only, with
allow-listed fields.

**When one fires:**

- `bot-errors`, `notify-errors`, `ws-errors`: read the function's log
  around then. Many `notify` failures with nothing else wrong mean Telegram
  is refusing the bot: a revoked or changed token (set `BOT_TOKEN` and raise
  `BOT_TOKEN_VERSION`), or Telegram is down. Dropped events with
  `lambda-throttles` mean the function had no room to run for a minute:
  load past its share (`RESERVE_CONCURRENCY`, the account's Lambda quota) or
  a flood of sends. Timeouts with a `<table>-table-throttles` alarm are a
  table at its cap. A single failure that doesn't come back can wait.
- `ws-client-errors`: the WebSocket API's throttle (`WS_THROTTLE_RATE_LIMIT`,
  `WS_THROTTLE_BURST_LIMIT`), which everyone shares, is used up. Apps that
  can't connect poll instead, so messages still arrive, later. With
  `ConnectCount` (namespace AWS/ApiGateway) far above what the `api`
  function's use suggests, or with `ws-integration-errors`, it's a flood of
  connects: nothing at the edge limits the WebSocket API, so raising the
  throttle only lets more of a flood through. With more of everything, it's
  real use: raise the throttle.
- `ws-integration-errors`: `ws` refused connects or failed: sessions that
  don't check out (forged, or ended: expected for a while after a deploy
  that replaced the session key), more connects than one account may make,
  or `ws` failing (then `ws-errors` or a table alarm fires too). Otherwise
  someone is connecting with junk, or one account over and over; each
  costs a `ws` run, within the throttle.
- `<table>-table-capacity`: look at the table's consumed units
  ([cost guards](#cost-guards)) next to the `api` function's invocations and
  [request counts](#request-counts). Real growth: raise
  `TABLE_MAX_READ_UNITS` or `TABLE_MAX_WRITE_UNITS`, and the bootstrap's
  `table_max_read_units` or `table_max_write_units` to match, before the
  cap turns people away. A flood: [the firewall](#the-firewall) and the
  count alarms say where it comes in; the cap still bounds the bill.
- `media-stored`: compare with the uploads of the last days (`PutRequests`
  in the bucket's request metrics, the `MediaTokenRequests` count). Real use
  deletes most attachments once fetched, so a steady climb without
  downloads is uploads parked on purpose. Pausing uploads
  ([emergency switches](#emergency-switches)) stops the growth; what is
  there expires after 30 days.
- `edge-5xx`: see which of these it comes with. `api-errors`: the function
  failing (its log). A `<table>-table-throttles` alarm: `503 unavailable`
  while a table is at its cap. Paused attachments: `503 uploads_paused` or
  `downloads_paused`, expected while paused. None of these: CloudFront can't
  reach the function URL, or is refused by it. CloudFront's metrics are in
  us-east-1 (namespace AWS/CloudFront, dimensions DistributionId and Region
  `Global`).
- `firewall-blocks`: a flood is being held off, or busy addresses are.
  The firewall's metrics (us-east-1, namespace AWS/WAFV2, dimensions WebACL
  `<prefix>-api` and Rule `<prefix>-api-<rule>`) say which rule blocks.
  CloudFront and the firewall still bill each blocked request, about $1.80
  per million together, and while `lookups-total` blocks, everyone's
  lookups by ID are refused. If it lasts, watch what it costs (CloudFront's
  `Requests`).

## Audit trail and change alerts

The bootstrap stack keeps a record of who changed what in the account, and
emails the changes that matter (`infra/init/audit.tf`).

**The trail.** One CloudTrail trail, `<prefix>-audit`, records the
account's management events in every region: each call that reads or
changes the account's settings (IAM, functions, buckets' settings,
parameters, CloudFront, the firewall and so on), by admins, by the deploy
role and by AWS services, with who made it, from which IP address and
when. It records no data events, so the app's reads and writes of table
items and attachments, and its invocations, aren't in it
([what it holds](data.md#on-the-server)). It writes a file every few
minutes to the bucket `<prefix>-audit-<random>` (output `audit_bucket`),
and a signed digest of each hour's files, so a changed or deleted file
shows. Files are kept 365 days (`audit_retention_days`, set with
`TF_VAR_audit_retention_days` at every rerun), then deleted; one deleted or
replaced before then stays 30 days more as an older version. The bucket's
policy lets only this trail write, and nobody delete a file. Deleting or
replacing a file is a data event, which nothing alerts on, so it first
takes changing that policy, which sends an alert, as does shortening the
lifecycle.
The deploy role can't call CloudTrail at all or touch the bucket
([above](#what-the-deploy-role-may-do)).

The first trail of management events in an account is free (another copy
would cost $2 per 100,000 events). The bucket costs about $0.30 a month: a
file per active region every 5 minutes or so and a digest per region every
hour, about 50,000 PUTs a month at $0.005 per 1,000, and some tens of MB a
month of compressed records at $0.023 per GB a month. The rules, the
events they match and Access Analyzer's external-access findings are
free; SNS sends the first 1,000 emails a month free.

**Reading it.** CloudTrail's event history holds the last 90 days of the
same events, in each region (IAM, CloudFront and the firewall in
us-east-1): the console (CloudTrail, Event history), or:

```shell
# What changed functions in the last day.
AWS_PROFILE=<profile> aws cloudtrail lookup-events --region <aws-region> \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=lambda.amazonaws.com \
  --start-time "$(date -u -d '-1 day' +%FT%TZ)" \
  --query 'Events[].[EventTime,EventName,Username]' --output table
# The whole record of the event an alert names (its region and event ID).
AWS_PROFILE=<profile> aws cloudtrail lookup-events --region <region> \
  --lookup-attributes AttributeKey=EventId,AttributeValue=<event-id> \
  --query 'Events[0].CloudTrailEvent' --output text | jq .
```

Older records are only in the bucket, one gzipped JSON file per region
every few minutes, and the digests show whether any was changed or
deleted:

```shell
bucket=$(terraform -chdir=infra/init output -raw audit_bucket)
AWS_PROFILE=<profile> aws s3 cp --recursive \
  "s3://${bucket}/AWSLogs/<account-id>/CloudTrail/<region>/<yyyy>/<mm>/<dd>/" trail/
zcat trail/*.json.gz | jq -r '.Records[] | select(.readOnly == false)
  | [.eventTime, .eventName, .userIdentity.arn] | @tsv'
AWS_PROFILE=<profile> aws cloudtrail validate-logs --region <aws-region> \
  --trail-arn "$(terraform -chdir=infra/init output -raw audit_trail_arn)" \
  --start-time <yyyy-mm-dd>
```

**The change alerts.** EventBridge rules match the account's management
events that change something, as AWS delivers them, and email the topic of
the region each is recorded in:

| Rule | Topic | When | Whose calls |
|---|---|---|---|
| `changes` | `alerts` | Functions (code, settings, URL, permissions, code signing), the signing profile, buckets' settings (policy, public access, versioning, lifecycle, logging…), parameters (written, deleted, shared), tables (exports, backups, restores, point-in-time recovery, streams, expiry, deletion protection, policies) | Anyone's but the deploy role's |
| `audit-changes` | `alerts` | CloudTrail (the trail stopped, changed or deleted, or another made in this region), Access Analyzer, EventBridge rules, SNS topics and subscriptions; logging: log deliveries, subscriptions, exports and retention, and the WebSocket API (its stage's logging, routes and integrations) | Anyone's |
| `global-changes` (us-east-1) | `edge-alerts` | IAM: roles, policies, users, groups, access keys, MFA, identity providers (all but the policy simulator and reports); and in us-east-1 too, another trail made, EventBridge rules, SNS topics, and logging (CloudFront's access logs are set up there, as log deliveries) | Anyone's |
| `edge-changes` (us-east-1) | `edge-alerts` | CloudFront and the firewall | Anyone's but the deploy role's |
| `access-findings` | `alerts` | IAM Access Analyzer found new access from outside the account (below) | |

A trail made in a region other than the app's and us-east-1 sends no
email; the trail records it.

They work only while the trail logs: EventBridge gets CloudTrail's events
only from a trail that is logging, and this is the account's only one.
Stopping or deleting it probably sends one last alert, and then none at
all, for anything, until the bootstrap turns it back on. So an alert on
`StopLogging`, `DeleteTrail`, `UpdateTrail` or `PutEventSelectors` is the
one to act on at once (below, "When one fires").

Each email names the call and the service, who made it (the caller's ARN
and kind), from which IP address, the region and the time, the error code
if AWS refused it (someone tried), and the command that prints the whole
record.

Deploys change functions, buckets, parameters, tables, CloudFront and the
firewall, and sign code, as their job, so the rules on those leave out the
deploy role's own calls: what a deploy changed is in its public log in
GitHub Actions (Terraform's plan and apply), and the trail records each
call. The rules on IAM, CloudTrail, logging and the WebSocket API include
its calls: it changes IAM only when the app stack changes a function
role's policy, the functions' log retention (`LOG_RETENTION_DAYS`) and the
WebSocket API only when the app stack changes them, all rare, and can't
call CloudTrail at all.

**How many emails.** None for a normal deploy; one or a few for a deploy
that changes a function role's policy, the log retention or the WebSocket
API. One per change an admin makes: a bootstrap rerun that changes
something sends one per call it makes, mostly IAM's (`edge-alerts`). The
first apply of this may send a few dozen, for the setup itself (the
bucket's settings, the rules and their targets, the topics' policies, the
policy versions, the trail, the analyzer), then the subscriptions, Access
Analyzer's first findings, and one for each finding archived.

**Access Analyzer.** An analyzer, `<prefix>-access`, in the app's region,
reads the policies of the account's roles, buckets, functions, topics and
so on, and makes a finding for each that lets another account, or anyone,
in. Some are on purpose, and are found at first: the deploy role (GitHub's
OIDC provider may assume it); while their URLs need no auth, `api` and
`bot` (anyone may call them); and any role admins sign in through from
another account (an AWS Organization's `OrganizationAccountAccessRole`, or
the roles IAM Identity Center makes). Read each once (IAM, Access
Analyzer) and archive those; each archive is a change, and sends an
`audit-changes` email. An archived finding stays archived while that
access stays as it is. They're archived by hand, not by an archive rule:
one wide enough to take `api`'s and `bot`'s public URLs would also take a
permission that lets anyone invoke them directly.

**When one fires:**

- The trail stopped, deleted or changed (`StopLogging`, `DeleteTrail`,
  `UpdateTrail`, `PutEventSelectors`): act at once. Rerun the bootstrap,
  which puts the trail back as it was. Until then no change alert is sent,
  for anything: read the event history (which records with the trail off
  too) for everything done between the stop and the rerun, then go on
  below for each call there you don't know.
- Read who made the call and from where. If it was you, another admin, or
  a deploy you know of (its run in GitHub Actions at that time), there's
  nothing to do.
- Otherwise take the caller's credentials as stolen. An admin's: end their
  sessions (in IAM, the role's "Revoke active sessions"; for a user,
  deactivate their access keys) and replace their password and keys. The
  deploy role's (an IAM, logging or WebSocket API change no deploy you
  know of made): a compromised CI job or approval
  ([security.md](security.md#other-limits)); end its sessions the same
  way, and stop deploys until you know how.
- Then undo the change. Rerun the bootstrap for what it manages (the roles
  and their policies, code signing, the trail, the alerts), and run a
  deploy for what the app stack manages: its plan shows and undoes changes
  to the functions, buckets, parameters, tables, log retention, the
  WebSocket API, CloudFront and the firewall, and its checks compare the
  running code with the attested build
  ([verifying.md](verifying.md#the-backend)). Delete what neither made: a
  role, a user, an access key, another trail, a function permission, a log
  delivery, subscription or export.
- An Access Analyzer finding that isn't on purpose: remove that access (the
  resource's policy), and find out in the trail who added it.

What they can't do against an admin: [security.md](security.md#other-limits).

**Applying the change that brought this**, in each environment in turn, dev
first: rerun the bootstrap before the change deploys there. Its plan adds
the trail, its bucket, the rules and the analyzer, a statement to each
topic's policy and two to `-github-deploy-limits`, and destroys nothing;
then every simulator check should pass. A deploy of the change against an
older bootstrap stops at the deploy role's check, before applying anything.
A few minutes later, `aws cloudtrail get-trail-status --name <prefix>-audit`
should show `IsLogging` true and no `LatestDeliveryError`. Then read Access
Analyzer's first findings and archive those on purpose.

## CloudFront in front of the API

A CloudFront distribution stands in front of the `api` function URL
(`infra/edge.tf`), so floods can be limited before they reach Lambda. It
caches nothing and logs nothing, and passes on only what the API reads: the
query string and a few headers (`Origin` and the CORS request headers,
`Content-Type`, `X-Session`, `X-Device-Signature`), with the body's hash
under its signature. No cookies, and not the headers CloudFront can add on
where a viewer is. `API_ACCESS` moves the app behind it one step at a time:

1. `direct` (default): the app calls the function URL. The distribution
   exists but isn't used; its address is the `api_cloudfront_url` output, to
   try it first.
2. `cloudfront`: the `api_url` output becomes CloudFront's address. Set the
   site's `API_URL` variable to it before deploying, since the deploy checks
   that the site was built for `api_url`. The function URL still answers, so
   an app that is still open keeps working.
3. `cloudfront-only`: the function URL requires AWS's signature, which only
   CloudFront adds, and refuses everyone else without running the function.
   The deploy checks that it does.

The AWS provider adds two statements of its own to the `api` function's
resource policy when it makes the URL with no auth (`direct`, the default):
`FunctionURLAllowPublicAccess` and `FunctionURLAllowInvokeAction`, which let
anyone call the function through its URL. It never removes them, and
Terraform doesn't track them, so no plan shows them. The switch to
`cloudfront-only` (the URL going from no auth to AWS's signature) leaves
them behind. They let no one in by themselves while the URL needs a
signature, but the deploy's check of who may invoke the functions refuses
them on a locked `api`. Remove them once as an admin, before the deploy
that switches (Terraform's own `FunctionUrlPublic` and `FunctionUrlInvoke`
keep the URL public until then) or after it, and re-run that deploy if the
check stopped it:

```shell
aws lambda remove-permission --function-name incognitochat-<env>-api --statement-id FunctionURLAllowPublicAccess
aws lambda remove-permission --function-name incognitochat-<env>-api --statement-id FunctionURLAllowInvokeAction
```

The distribution answers over IPv4 only. The firewall counts each IPv6
address on its own, and one server can have a /64 of them (2^64 addresses),
so over IPv6 its per-address limits would hold no one. Devices with both use
IPv4. Devices on networks with IPv6 alone reach it through their network's
NAT64, sharing an IPv4 address with others there, as they already reach the
socket API and the media bucket, which have no IPv6 addresses either; a
network with IPv6 and no NAT64 can't reach the API at all.

What turning IPv6 off does is documented only for DNS: CloudFront gives the
distribution's name no IPv6 addresses. AWS's documentation doesn't say
whether an edge refuses a request that reaches it over IPv6 anyway, from a
client that connects to an edge's IPv6 address by hand, and this hasn't been
tested. If edges serve such requests, one host can still spread a flood
over many IPv6 addresses past both per-address rules: `lookups-total` still
bounds lookups by ID, and nothing at the edge bounds the rest. A rule that
blocks IPv6 addresses outright would settle it, with an IP set, which the
deploy role may now manage (`infra/init`).

### The firewall

`FIREWALL=true` adds AWS WAF in front of CloudFront with three rate limits,
and before them a list of addresses to block, empty until an admin fills it
([blocking addresses](#blocking-addresses)). It only protects the API once
`API_ACCESS` is `cloudfront-only`: before that, the function URL can be
called around it. It keeps no sampled requests, which would hold addresses.
Its metrics are counts only, but AWS adds counts per country and device
type, which CloudWatch keeps for 15 months; they can't be deleted
([data.md](data.md#on-the-server)). It costs $5 a month, $1 a month per
rule (four, the block list's included), and $0.60 per million requests it
looks at, blocked ones included: $9 a month plus requests.

| Rule | Counts | Limit | Variable |
|---|---|---|---|
| `rate-per-ip` | every request, per IP address | 2,000 in 5 minutes | `FIREWALL_RATE_LIMIT` |
| `anonymous-per-ip` | requests to the routes that need no login, per IP address | 500 in 5 minutes | `FIREWALL_ANONYMOUS_RATE_LIMIT` |
| `lookups-total` | lookups of links and uploads by ID, everyone together | 12,000 in 1 minute (30 times the read cap) | `FIREWALL_LOOKUPS_TOTAL_LIMIT` |

The routes that need no login, which `anonymous-per-ip` counts, are
`POST /session`, `POST /register`, `POST /accounts/lookup`, `POST /send`,
`GET /links/{id}`, `GET /media/{id}` and `POST /media/{id}/upload`: each
reads a table before any limit of its own, or, for sends, is paid with a
token but has no login. Two more need no login and are left to
`rate-per-ip`: `POST /media` spends no table capacity on forged media
tokens, and the app sends `POST /media/{id}/delete` for every received
attachment of a deleted chat, six at a time without a pause, which a low
limit would cut off.

The lookups by ID, which `lookups-total` counts, are `GET /links/{id}` (a
link's bundle), `GET /media/{id}` (a download URL), `POST /media/{id}/upload`
(a fresh upload URL) and `POST /media/{id}/delete`: anyone can make them
with random IDs. It never counts logins, registrations, account lookups or
sends.

A path counts if it ends like one of these routes once decoded and
normalised (`/%73ession`, `//session` and `/../session` count as
`/session`).

- **`rate-per-ip`**: many people can share an address (a mobile carrier, a
  VPN), so the limit is far above what one person's app sends.
- **`anonymous-per-ip`**: an app sends few requests to these routes. A login
  lasts 15 minutes; a link's keys are fetched when it is opened, and at most
  hourly while writing to a link that hasn't answered; photos are fetched one
  at a time. Most of it is sends: each message, reaction, edit and "seen"
  receipt is one, and the server takes at most 30 a minute for one mailbox.
  Someone chatting fast sends about 25 a minute, so at most about 150 to 200
  in 5 minutes all told; most people send under 30. 500 leaves room for two
  or three people that busy, or fifteen or so ordinary ones, behind one
  address. Past it, only these routes are blocked for that address; requests
  with a session go on.

  Logins, registrations, account lookups and sends have only the per-address
  rules, so a flood of them spread over many addresses is bounded only by
  the tables' caps. The cheapest: an account logging its own device in again
  and again writes a login nonce each time, one write unit on the ephemeral
  table, and nothing limits that per device; filling production's 200 writes
  a second that way takes about 120 addresses, each just under 500 in 5
  minutes. Logins of random devices read half a directory unit each and
  write nothing; filling its 400 reads a second takes about 480 addresses.
  A limit on logins per device (backend) would close the first.
- **`lookups-total`**: everyone's lookups by ID, over one minute so that a
  block ends soon after a flood does. With a random ID, a lookup writes
  nothing and reads half a unit (a link's bundle from the directory; a
  download URL or a delete from the ephemeral table, eventually consistent)
  or, for a fresh upload URL, one unit (strongly consistent, ephemeral). So
  at 30 times the read cap a minute (12,000 in production, 200 a second) a
  flood of them uses at most half the ephemeral table's reads and a quarter
  of the directory's, and everything else keeps the rest. They write only
  with the IDs of uploads paid for with media tokens, a few times each (5
  downloads a day, 3 fresh URLs, one delete). Unless
  `FIREWALL_LOOKUPS_TOTAL_LIMIT` is set, the limit follows the read cap, and
  it may never be set above it (the deploy's plan fails).

  Rules run in order, and what `rate-per-ip` or `anonymous-per-ip` already
  blocks doesn't count here. Held up for minutes, setting it off takes about
  30 addresses (deletes are limited per address only by `rate-per-ip`, 400 a
  minute). But AWS WAF checks rates only about every 10 seconds and usually
  takes up to 30 to act, and until an address is blocked, everything it
  sends counts here, so a burst from a single host can set it off alone.

  While it blocks, only lookups by ID are refused, for everyone, until the
  rate falls: usually a minute or two after the flood stops (60 to 90
  seconds after a short burst). Links don't open (the app says to try
  later); attachments don't download (fetching by itself pauses); an upload
  whose first PUT failed can't get a fresh URL, so it shows as not sent and
  Try again pays for it again; uploads to delete wait for the app's next
  start or upkeep.
  Logins, sends and everything with a session go on.

A blocked request gets 429 with the API's own error,
`{"error":"rate_limited"}`, and `Access-Control-Allow-Origin` for the app
(the first of `CLIENT_ORIGINS`: a firewall response is fixed, while the API
answers each origin in the list), so the app can tell being turned away from
being offline. Either way it waits instead of asking again at once: a
failed login waits 5 to 10 seconds, twice as long after each further
failure up to one to two minutes; a link's keys that couldn't be fetched
wait 5 to 10 minutes; and attachments stop being fetched by themselves for
one to two minutes. The waits are jittered, so the apps behind one address
don't try together and keep it blocked. A blocked CORS preflight (only
`rate-per-ip` counts those) still looks like a network error to the app.

AWS WAF checks rates about every 10 seconds and doesn't match a limit
exactly: a flood usually gets through for up to 30 seconds before it's
blocked (sometimes longer, AWS says), and a block can outlast it by as long.

**What to watch**, in CloudWatch in us-east-1 (namespace AWS/WAFV2,
dimension WebACL `<prefix>-api`, and Rule, each rule's metric name:
`<prefix>-api-blocked`, `<prefix>-api-rate-per-ip`,
`<prefix>-api-anonymous-per-ip`, `<prefix>-api-lookups-total`):
`BlockedRequests` for each rule, and `AllowedRequests` with Rule `ALL`. The
metrics are free; no alarm watches them yet.

- `anonymous-per-ip` blocking now and then is one busy address. Blocks
  that recur every day while the tables are far below their caps, and
  `AllowedRequests` looks like ordinary use, may be people behind a shared
  address: raise `FIREWALL_ANONYMOUS_RATE_LIMIT`.
- `lookups-total` blocking at all means lookups were refused for everyone
  for a while. With the ephemeral or directory table's reads near their
  caps it was a flood, or real growth: if it's growth, raise the caps (the
  limit follows).
- `rate-per-ip` as before.

### Blocking addresses

During an incident, an admin can block addresses at the firewall (where
`FIREWALL` is on) by adding them to its IP set `<prefix>-blocked`
(us-east-1, scope CloudFront). Its rule, `blocked`, runs before the rate
limits, so they don't count what it refuses, and answers as they do (429,
`{"error":"rate_limited"}`): an app caught by a blocked range waits instead
of asking again at once. A change takes effect within about a minute.

Addresses are IPv4 (the API answers over IPv4 alone), in CIDR form:
`192.0.2.7/32` for one address, `198.51.100.0/24` for a range. In the
console: WAF & Shield, IP sets, region Global (CloudFront), then
`<prefix>-blocked`, Add IP address. With the CLI, as an admin
(`update-ip-set` replaces the whole list, so name the addresses already
there too, from `get-ip-set`, with its `LockToken`):

```shell
id=$(aws wafv2 list-ip-sets --scope CLOUDFRONT --region us-east-1 \
  --query "IPSets[?Name=='incognitochat-<env>-blocked'].Id" --output text)
aws wafv2 get-ip-set --scope CLOUDFRONT --region us-east-1 --name incognitochat-<env>-blocked --id "$id"
aws wafv2 update-ip-set --scope CLOUDFRONT --region us-east-1 --name incognitochat-<env>-blocked --id "$id" \
  --lock-token <LockToken> --addresses 192.0.2.7/32 198.51.100.0/24
```

Terraform ignores the set's addresses, so deploys keep them. Everything
else in the firewall is Terraform's: a rule added or a limit changed in the
console is undone by the next deploy (for production, the next release),
with no one asked. For a lasting change, change `infra/edge.tf` or the
limits' variables.

The rule costs $1 a month, empty or not. Blocked requests are still billed
(CloudFront and the firewall, about $1.80 per million), show as
`BlockedRequests` with Rule `<prefix>-api-blocked`, and count towards the
`firewall-blocks` alarm, which may stay on while a blocked host keeps
sending. Remove the addresses once the incident is over: a shared address
blocks everyone behind it. Empty the set before turning `FIREWALL` off,
too: the deploy that deletes it prints its addresses in the plan, in public
logs.
