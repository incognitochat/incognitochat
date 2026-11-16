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
  the bootstrap stack and can't change its own permissions.
- It checks that each function runs the attested bundle plus its signature
  ([verifying.md](verifying.md#the-backend)).
- It then sets up the bot (the function registers its own webhook, menu
  button and commands, so the bot token never passes through CI), and runs
  smoke tests: the API, the webhook and the socket refuse what they should.
- Last, it asks the hosting repository to build and deploy the app from the
  same commit (production: the release tag), and waits until the site serves
  it ([verifying.md](verifying.md), [hosting/](../hosting/README.md)). The
  request names the commit too, and the hosting repository refuses to build
  any other commit, or one that isn't on `main` itself (not merged in from
  another branch). Before deploying anything, CI checks that the hosting
  repository's workflow takes that request.

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
   request up to date with `main`, so it can always be merged.
2. Merging that pull request is the decision to release. release-please then
   tags the merge commit and publishes a GitHub Release with the changelog.
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
role, the Lambda permissions boundary, code signing and the alerts below
(`infra/init`), and the GitHub environment `<env>`, which accepts deploys from `main` only (dev)
or from release tags only, with required reviewers (production), with the
secrets and variables it computed (`AWS_ACCOUNT_ID`, `AWS_ROLE_ARN`,
`TF_STATE_BUCKET`, `LAMBDA_BUILDS_BUCKET`, `LAMBDA_SIGNING_PROFILE`,
`LAMBDA_CODE_SIGNING_CONFIG`, `AWS_REGION`).

Code signing is a versioned bucket for the bundles, an AWS Signer profile,
and a code signing config set to enforce. Every function must use the config,
so Lambda runs only code signed by the profile. The deploy role can upload
and sign, but can't change the bucket's settings, the profile or the config,
nor create a function without the config or remove it. If CI were ever
compromised, an admin can revoke the profile from a given time, after which
Lambda refuses to deploy anything it signed, and replace the profile by
rerunning the bootstrap.

Alerts are a monthly cost budget (`MONTHLY_BUDGET=<dollars>` when
bootstrapping; 50 for production and 10 otherwise by default) and a few
alarms, all publishing to one SNS topic, `incognitochat-<env>-alerts`:

| Alert | When |
|---|---|
| Budget | Half the budget is spent, all of it is, or the month is forecast to pass it. Billing data lags by hours. |
| `lambda-throttles` | Any function was refused for lack of concurrency. |
| `api-invocations` | The `api` function was called more than 30,000 times in 5 minutes (100 a second). |
| `api-errors` | The `api` function failed more than 10 times in 5 minutes. |
| `<table>-table-throttles` | A table refused requests because its per-second cap was reached. |
| `media-uploads`, `media-downloads` | The media bucket had more than 3,000 PUT or GET requests in 5 minutes (10 a second; `media_requests_alarm`). These go straight to S3, past the API and its alarms, and each is billed. They read the bucket's request metrics, which the app stack turns on. Those are billed like custom metrics, $0.30 a month each for up to 16, counted only in hours with requests: at most about $5 a month per environment. |
| `media-download-bytes` | More than 2 GiB was downloaded from the media bucket in 5 minutes (about 7 MB a second; `media_download_gib_alarm`). Downloads cost by the data sent: one 51 MiB download costs as much as about 11,000 GET requests. Same request metrics. |

What to do when a media alarm fires: [emergency switches](#emergency-switches).

The topic starts without subscribers, so no address is stored in the
repository or in Terraform state. Subscribe one, and confirm the email AWS
sends:

```shell
AWS_PROFILE=<profile> aws sns subscribe --region <aws-region> --protocol email \
  --topic-arn "$(terraform -chdir=infra/init output -raw alerts_topic_arn)" \
  --notification-endpoint <address>
```

CI can't change these alerts: they belong to the bootstrap stack. Once the
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
| `ADMIN_TELEGRAM_IDS` | secret | Comma-separated Telegram user IDs of admins. A secret, so the IDs stay out of the public deploy logs; the API keeps only their keyed hashes. |
| `CLIENT_ORIGINS` | variable | Origins allowed to call the API from a browser: the app's `https://<org>.github.io`. |
| `INVITE_ONLY` | variable | `true` by default: only accounts that joined through an invitation, and admins, can own links. |
| `RESERVE_CONCURRENCY` | variable | `true` gives each function its own share of the account's concurrent executions (`api` 100, `notify` 20, `ws` 10, `bot` 5), so a flood on one can't starve the others. Off by default: it needs a Lambda concurrency quota of at least 235 in the account (new accounts start at 10; ask for more in Service Quotas). |
| `API_ACCESS` | variable | How the app reaches the API (below): `direct` (default), `cloudfront` or `cloudfront-only`. |
| `FIREWALL` | variable | `true` puts a firewall (AWS WAF) in front of CloudFront, limiting requests per IP address (2,000 in 5 minutes). Off by default: it costs a few dollars a month. |
| `DELETION_PROTECTION` | variable | Protects the tables from deletion. Keep it on in production. |
| `SECRETS_VERSION` | variable | Raise it to replace the generated secrets (session key, Telegram-ID pepper, webhook secret). Replacing the pepper starts every account over. |
| `PAGES_REPO`, `PAGES_URL` | variables | The hosting repository and the site's address, for starting its deploy and waiting for it. |
| `PAGES_DISPATCH_TOKEN` | secret | A token that can only start the hosting repository's workflow. |

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
set the hosting repository's `ISSUER_KEY` variable to that name.

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

## Secrets at rest

Secrets (the bot token, the session key, the Telegram-ID pepper, the webhook
secret, the issuer key, the key that seals chat IDs) are SSM parameters
written through Terraform's write-only arguments, so they never land in
Terraform state or plans. Each function's role can read only the parameters
it needs: only `bot` and `notify` can read the bot token.

## Cost guards

The tables are on-demand with per-table caps on read and write units, the
WebSocket API is throttled, and nothing runs when idle. Logs are kept 7 days.
A budget and alarms watch the account, and each function can be given its
own share of concurrency (`RESERVE_CONCURRENCY`), both above.

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

## CloudFront in front of the API

A CloudFront distribution stands in front of the `api` function URL
(`infra/edge.tf`), so floods can be limited per IP address before they reach
Lambda. It caches nothing and logs nothing. `API_ACCESS` moves the app
behind it one step at a time:

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

`FIREWALL=true` adds AWS WAF in front of CloudFront with one rule: at most
2,000 requests in 5 minutes from one IP address (`firewall_rate_limit`).
Many people can share an address (a mobile carrier, a VPN), so the limit is
far above what one person's app sends. It keeps no sampled requests, which
would hold addresses. It only protects the API once `API_ACCESS` is
`cloudfront-only`: before that, the function URL can be called around it.
