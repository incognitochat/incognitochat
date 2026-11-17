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

CI never changes `infra/init` (it can't change its own permissions). When a
change touches it, rerun the bootstrap in each environment before that
change deploys there. Each deploy checks this with IAM's policy simulator
(`scripts/check-function-roles.sh`), because a refused call between functions
would only log a warning: sends would still succeed while pushes and notices
stopped.

- Before applying anything, it asks whether the permissions boundary lets
  the existing roles make the invokes this code makes (`api` invoking `ws`
  and `notify`, `ws` invoking `notify`), as if the roles' own policies
  allowed them. A first deploy, with no roles yet, skips this.
- After applying, it asks whether each function's role, its policy and the
  boundary together, allows every call the functions make to each other
  (those, and `ws` posting to sockets).

Either fails the deploy if a call is refused, or if the deploy role may not
ask (an older `infra/init`), and asks again a few times when IAM is slow or
throttles.

Code signing is a versioned bucket for the bundles, an AWS Signer profile,
and a code signing config set to enforce. Every function must use the config,
so Lambda runs only code signed by the profile. The deploy role can upload
and sign, but can't change the bucket's settings, the profile or the config,
nor create a function without the config or remove it. If CI were ever
compromised, an admin can revoke the profile from a given time, after which
Lambda refuses to deploy anything it signed, and replace the profile by
rerunning the bootstrap.

Alerts are a monthly cost budget (`MONTHLY_BUDGET=<dollars>` when
bootstrapping; 50 for production and 15 otherwise by default) and a few
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
| `RESERVE_CONCURRENCY` | variable | `true` gives each function its own share of the account's concurrent executions (`api` 100, `ws` 20, `notify` 10, `bot` 5), so a flood on one can't starve the others. Off by default: it needs a Lambda concurrency quota of at least 235 in the account (new accounts start at 10; ask for more in Service Quotas). |
| `API_ACCESS` | variable | How the app reaches the API (below): `direct` (default), `cloudfront` or `cloudfront-only`. |
| `FIREWALL` | variable | `true` puts a firewall (AWS WAF) in front of CloudFront, with three rate limits ([below](#the-firewall)). Off by default: about $8 a month, plus $0.60 per million requests. |
| `DELETION_PROTECTION` | variable | Protects the tables from deletion. Keep it on in production. |
| `SECRETS_VERSION` | variable | Raise it to replace the generated secrets (session key, Telegram-ID pepper, webhook secret, chat key). Replacing the pepper starts every account over. The short-lived records named with keys from these secrets just start afresh: every rate limit for its minute, hour or day; socket records, so open apps get a notice instead of a push until they reopen their sockets (within about half an hour); and the 3-minute gap between notices. |
| `PAGES_REPO`, `PAGES_URL` | variables | The hosting repository and the site's address, for starting its deploy and waiting for it. |
| `PAGES_DISPATCH_TOKEN` | secret | A token that can only start the hosting repository's workflow. |

The limits below can be tuned without a code change, but none needs
setting: unset, each takes its default from
[`infra/variables.tf`](../infra/variables.tf), and where an environment
needs other values, the defaults depend on its name (`production`, or
anything else), so an environment comes from the repository alone.

| Name | Default | What |
|---|---|---|
| `TABLE_MAX_READ_UNITS`, `TABLE_MAX_WRITE_UNITS` | 400 and 200 in production, 200 and 100 elsewhere; at most 3,000 and 1,000 | Each table's cap on read and write request units a second ([cost guards](#cost-guards)). Elsewhere is lower: dev has no firewall and a small budget. At most 3,000 and 1,000, what one partition can take: sends to mailboxes that don't exist all read and write the same few placeholder items, which must not be throttled before the table is. |
| `FIREWALL_RATE_LIMIT` | 2,000 | Requests one IP address may make in 5 minutes, to any route (`rate-per-ip`). |
| `FIREWALL_ANONYMOUS_RATE_LIMIT` | 500 | Requests one IP address may make in 5 minutes to the routes that need no login (`anonymous-per-ip`). At most `FIREWALL_RATE_LIMIT`. |
| `FIREWALL_LOOKUPS_TOTAL_LIMIT` | 30 times the read cap: 12,000 in production | Lookups of links and uploads by ID everyone together may make in 1 minute (`lookups-total`). At most 30 times the read cap, so it follows the caps when unset. |
| `WS_THROTTLE_RATE_LIMIT`, `WS_THROTTLE_BURST_LIMIT` | 20, 40 | The WebSocket API's throttle, shared by everyone: requests a second, and the burst. At least 1. |

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

The tables are on-demand, each capped at 400 read and 200 write request
units a second in production, and at 200 and 100 in any other environment
(`TABLE_MAX_READ_UNITS`, `TABLE_MAX_WRITE_UNITS`). Past a cap a table
refuses requests, which cost nothing, and its `<table>-table-throttles`
alarm fires. The caps bound the tables' bill. At eu-west-1's on-demand
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
`<prefix>-<table>`; the sum over a minute divided by 60 is the rate). Raise
the caps once real use regularly passes half of them; unless
`FIREWALL_LOOKUPS_TOTAL_LIMIT` is set, the firewall's limit on lookups
follows ([the firewall](#the-firewall)).

The WebSocket API is throttled (`WS_THROTTLE_RATE_LIMIT`,
`WS_THROTTLE_BURST_LIMIT`), and nothing runs when idle. Logs are kept 7
days. A budget and alarms watch the account, and each function can be given
its own share of concurrency (`RESERVE_CONCURRENCY`), both above.

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
(`infra/edge.tf`), so floods can be limited before they reach Lambda. It
caches nothing and logs nothing. `API_ACCESS` moves the app behind it one
step at a time:

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
blocks IPv6 addresses outright would settle it, but the deploy role would
need to manage IP sets for it (`infra/init`).

### The firewall

`FIREWALL=true` adds AWS WAF in front of CloudFront with three rate limits.
It only protects the API once `API_ACCESS` is `cloudfront-only`: before that,
the function URL can be called around it. It keeps no sampled requests,
which would hold addresses. It costs $5 a month, $1 a month per rule, and
$0.60 per million requests it looks at, blocked ones included: $8 a month
plus requests.

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
`<prefix>-api-rate-per-ip`, `<prefix>-api-anonymous-per-ip`,
`<prefix>-api-lookups-total`): `BlockedRequests` for each rule, and
`AllowedRequests` with Rule `ALL`. The metrics are free; no alarm watches
them yet.

- `anonymous-per-ip` blocking now and then is one busy address. Blocks
  that recur every day while the tables are far below their caps, and
  `AllowedRequests` looks like ordinary use, may be people behind a shared
  address: raise `FIREWALL_ANONYMOUS_RATE_LIMIT`.
- `lookups-total` blocking at all means lookups were refused for everyone
  for a while. With the ephemeral or directory table's reads near their
  caps it was a flood, or real growth: if it's growth, raise the caps (the
  limit follows).
- `rate-per-ip` as before.
