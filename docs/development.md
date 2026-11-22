# Development

How the code is laid out, how to run every check CI runs, and the rules for
dependencies. Deploying is in [deployment.md](deployment.md).

## Layout

| Path | What |
|---|---|
| `backend/` | Go, one module. `cmd/` has one Lambda entry point per trust boundary: `api` (HTTPS API), `bot` (Telegram webhook), `ws` (WebSocket connections and pushes), `notify` (Telegram notices). `internal/` holds the packages: `api` (routes and handlers), `telegram` (launch data and the Bot API), `session` and `devicesig` (logins and signed requests), `envelope`, `inbox`, `links`, `invitations`, `tokens` (blind-signed send and media tokens), `media`, `notices`, `push`, `bot` (the webhook's answers and the deploy's bot setup), `i18n` (what the bot and notices say in each of the app's languages, and which language a Telegram language code picks), `devicelist` (signed device lists), `keyed` (keyed-hash names for short-lived rows), `ids` (random IDs), `httpapi` (routing and JSON answers), `config` (settings and SSM secrets at startup), `logx` (the only logger), `tally` (per-minute request counts), `awsconf` (how AWS calls are retried and cut off), the DynamoDB stores `directory` and `ephemeral`, and `dynamotest` (store tests against DynamoDB Local). |
| `web/` | The app: TypeScript, Vite, Preact with signals. `src/crypto` (WebCrypto only: keys, HPKE, signatures, blind RSA), `src/protocol` (envelopes, messages, links), `src/messaging` (the engine: sending, syncing, rotation, the history store), `src/media` (preparing, recording, saving attachments), `src/emoji` (the emoji panel's list), `src/stickers`, `src/storage` (IndexedDB), `src/platform` (the Telegram bridge, launch data, theme), `src/net` (API and socket), `src/state` (screens and actions), `src/account` (setup, login, the link, invitations, token wallets, usage), `src/sync` (locks between copies of the app open at once), `src/i18n` (English and Persian), `app.tsx` (the screens), `save.tsx` (the save page, opened in the device's browser), `storage-screen.tsx` (shown when the app's storage can't be opened). |
| `web/public/` | Files copied into the build as they are: the sticker images and their license. |
| `infra/` | App Terraform for one environment: tables, the media bucket, SSM parameters, the four functions with function URLs, the WebSocket API. Applied by CI. |
| `infra/init/` | Bootstrap Terraform, applied once per AWS account by an admin: state bucket, GitHub OIDC provider, deploy role, the functions' roles and their permissions boundary, code signing. CI can't change its own permissions. |
| `hosting/` | The reviewed copy of the hosting repository's workflow ([verifying.md](verifying.md)). |
| `scripts/` | `bootstrap.sh`, `build-lambdas.sh` (reproducible Lambda bundles), `check-lambda-deploy.py` (checks a deploy runs the attested bundles), `check-function-roles.sh` (checks the functions may call each other, permissions boundary included, what the deploy role is denied, and whom the functions' resource policies let invoke them), `check-pins.sh` (checks that versions pinned in several places agree), `check-version-variables.sh` (checks the deploy passes each secret's version variable), `verify-site.sh`. |
| `docs/` | This documentation. |

## Checks

Everything CI runs can be run locally.

**Backend** (the Go toolchain is pinned in `backend/go.mod`):

```shell
cd backend
gofmt -l .
go vet ./...
go test -race ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
../scripts/build-lambdas.sh   # prints the SHA-256 of each bundle
```

The DynamoDB store tests skip unless DynamoDB Local is running (CI always runs
them):

```shell
podman run --rm -d -p 127.0.0.1:8000:8000 docker.io/amazon/dynamodb-local:3.3.2
DYNAMODB_ENDPOINT=http://localhost:8000 go test -race ./...
```

**Web** (Node is pinned in `web/.nvmrc`; the tests need it, for Web Locks):

```shell
cd web
npm ci
npm audit signatures
npm run typecheck
npm test
npm run build
```

**Terraform:**

```shell
terraform fmt -check -recursive -diff infra
for dir in infra infra/init; do
  terraform -chdir="$dir" init -backend=false -lockfile=readonly
  terraform -chdir="$dir" validate
done
terraform -chdir=infra test        # renders function role policies; no AWS calls
terraform -chdir=infra/init test   # renders the deploy role's policies; no AWS calls
```

**Pins:** `scripts/check-pins.sh` (the workflows' Terraform versions agree,
and `hosting/deploy.yml` pins the same actions as `.github/workflows`).

## Reproducible builds

The same commit always produces byte-identical Lambda bundles and web files,
and CI builds everything twice and compares. Keep it that way:

- Go builds use `-trimpath -buildvcs=false`, a pinned toolchain, fixed file
  modes, and zip timestamps in UTC (`scripts/build-lambdas.sh`).
- The web build is one deterministic JavaScript file and one stylesheet, with
  no lazy chunks: a deploy replaces the whole site, so a cached page must never
  point at chunks that are gone. Static files the app fetches (such as sticker
  images) go in `web/public/` and are fetched by path. Importing them through
  Vite (`?url`) puts randomly ordered file references in the source map.
- The build settings come from `VITE_*` variables, checked by
  `web/vite.config.ts`. A build without them works but can't reach a backend.

## Dependencies and supply chain

- GitHub Actions are pinned to commit SHAs; Terraform provider lock files are
  committed.
- npm installs exact versions only, runs no install scripts, accepts no git
  dependencies, and refuses packages published less than 7 days ago
  (`web/.npmrc`). CI verifies registry signatures.
- `govulncheck` runs on every build. Every week, `.github/workflows/scan.yml`
  runs it again, and `npm audit` on the app's runtime dependencies, so a new
  advisory shows without a code change.
- Dependabot proposes updates with a 7-day cooldown: the actions in
  `.github/workflows`, Go modules, npm packages, and the Terraform providers
  of `infra/` and `infra/init/`. What it doesn't cover is
  [updated by hand](#updating-by-hand).
- The app loads no third-party code at runtime. Its only runtime dependencies
  are Preact, its signals, and `idb`.
- The backend's are the AWS SDK and Lambda runtime, Cloudflare's `circl`
  (checking blind-RSA tokens), and
  `filippo.io/bigmod` (constant-time arithmetic for signing tokens, the code
  Go's `crypto/rsa` uses). bigmod compiles in `golang.org/x/sys/cpu` (the
  Go team's, BSD-licensed), to pick its assembly for the CPU.

### Updating by hand

Dependabot doesn't update these. Check them every month or so, and when the
weekly scan reports a fix in a newer version:

- **Go:** the `toolchain` line in `backend/go.mod`. CI fails if it gets
  another Go, and `scripts/build-lambdas.sh` builds with it.
- **Node:** `web/.nvmrc`, used by CI, the scan and the hosting workflow.
- **Terraform CLI:** `TERRAFORM_VERSION` in `ci.yml` and
  `deploy-environment.yml`. CI fails if they differ.
- **govulncheck:** its version in `ci.yml`, `scan.yml` and the commands above.
- **DynamoDB Local:** the image's tag and digest in `ci.yml`, and its tag in
  the commands above and `backend/internal/dynamotest`.
- **The hosting workflow's actions:** `hosting/deploy.yml` is outside
  `.github/workflows`, so Dependabot doesn't see it. CI warns when an action
  it shares with `.github/workflows` is pinned to another commit;
  `upload-pages-artifact` and `deploy-pages` are only there. Copy each change
  into the hosting repositories ([hosting/README.md](../hosting/README.md)).

## Conventions

- **No environment-specific values in the repository:** no account IDs,
  bucket names, bot names, URLs or tokens. They live in GitHub environment
  variables and secrets, Terraform outputs, and the hosting repository's
  variables. Docs use placeholders such as `<bot>`, `<app>` and `<org>`.
- Commits and pull request titles follow Conventional Commits. Changes to
  `main` go through pull requests, squash-merged; a push to `main` deploys to
  dev. The titles set the next version and the changelog
  ([releases](deployment.md#releases)).
- The protocol is documented in [protocol.md](protocol.md) together with the
  code that implements it; change both in the same pull request.
- User-facing text is written in English and Persian (`web/src/i18n`), and
  layout uses logical CSS properties, so right-to-left needs no special cases.
