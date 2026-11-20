# Hosting

The client is served by GitHub Pages from a hosting repository,
`<org>/<org>.github.io`, in a GitHub organization of its own
([verifying.md](../docs/verifying.md#how-the-app-is-published)):
all Pages sites of one owner share an origin, and with it the keys stored in
the browser. The dev site has its own organization too.

The hosting repository holds no application code, only
[`deploy.yml`](deploy.yml) (as `.github/workflows/deploy.yml`). It builds one
commit (dev) or release tag (production) of this repository, writes
`manifest.json`, attests every file with Sigstore, and deploys with Pages' own
action. This directory keeps the reviewed copy; the hosting repositories run
theirs.

Before building, it checks what it checked out, and stops on anything else:

- a release tag is checked out by its full name, `refs/tags/vX.Y.Z`. That
  tag must exist, and the checkout must be a detached commit, never a
  branch, whatever the branch is called;
- the commit, or the tag's commit, must be on `RELEASE_BRANCH` itself,
  among its first parents: a commit that only came in through a merge
  doesn't count;
- CI also sends the commit it deployed the backend from (`commit`), and the
  checkout must be exactly that commit;
- the site only moves forward: the commit must be the live site's (the one
  its `manifest.json` names) or come after it, and a release tag mustn't be
  lower than the live one, unless the request says `rollback: true`
  ([below](#rolling-back)). With no live manifest to compare with (the first
  deploy, or it can't be read), the run warns and builds anyway.

## Setting up a hosting repository

1. Create `<org>/<org>.github.io` (public), with `deploy.yml` as
   `.github/workflows/deploy.yml` on its default branch, `main`. Copy it byte
   for byte: `verify-site.sh` accepts only attestations made by a copy that
   was on this repository's `main`, run from the hosting repository's `main`.
2. Set Pages to deploy from GitHub Actions:
   `gh api -X PUT repos/<org>/<org>.github.io/pages -f build_type=workflow`.
3. Repository variables: `CODE_REPOSITORY` (`incognitochat/incognitochat`),
   `REFS` (`commits` for dev, `tags` for production), `RELEASE_BRANCH`
   (`main`), `API_URL` (the `api_url` Terraform output),
   `BOT_USERNAME`, `APP_NAME`, `ISSUER_KEY` (the name of the environment's
   token issuer keys in `web/issuer-keys.json`; when they are replaced, it
   changes as [deployment.md](../docs/deployment.md#rotating-an-issuer-key)
   says), and `WS_URL` (the
   `ws_url` Terraform output; optional: without it the app polls), and
   `MEDIA_ORIGIN` (the `media_origin` output; optional: without it
   attachments are off).
4. A fine-grained personal access token, owned by the hosting organization,
   for that one repository, with **Actions: read and write** only. Store it
   in this repository's environment as `PAGES_DISPATCH_TOKEN`. It can't
   change the repository's files or settings, but it can do more than start
   a deploy: it can start the workflow with any inputs (`rollback: true`
   included), re-run, cancel and delete its runs and their logs, and turn
   the workflow off. Whoever holds it can keep the site from updating, or
   roll it back to an older build of `main`, but can't publish anything else.
5. In the organization's settings: require two-factor authentication, disallow
   Pages for members and deploy keys, and keep the free plan. No other
   repository in the organization may have Pages, owners' included (the
   setting doesn't bind them): its pages would share the app's origin and
   keys. `verify-site.sh` fails if one does.
6. Protect `main` with a ruleset: changes only through pull requests, and
   no force-pushes or deletion.

## Updating the workflow

The hosting repositories' copies are updated by hand from this one, byte for
byte. `verify-site.sh` accepts a site signed by any copy that was on `main`,
so merge a change to `deploy.yml` here first, then copy it. Both hosting
repositories protect `main` with a ruleset (changes only through pull
requests, no force-pushes or deletion), so the copy goes in with a small
pull request in each. A request with an input the hosting workflow doesn't
declare fails, so when CI starts sending a new input, change `deploy.yml` in
one pull request, copy it into both hosting repositories, and only then
merge the change to CI.

That request is the last step of a deploy, after the backend is live. So
before deploying anything, CI reads the hosting repository's `deploy.yml` and
stops if it doesn't declare the `commit` input.

## Rolling back

The workflow refuses to build anything older than the live site, so a
mistaken or replayed request, such as a re-run of an old CI run, can't put
an older build live. The app's storage on each device only moves forward:
once a newer app has upgraded it, an older one can't open it. 2.4.0 raised
it to version 5 (IndexedDB), and any older build would give every user a
blank app.

A re-run is checked again, against the site as it is then: re-running the
live build's run passes, re-running an older one fails. The deploy job checks
too, so re-running it alone fails once another build has gone live since.

A deliberate rollback says so in its request:

```shell
gh workflow run deploy.yml --repo <org>/<org>.github.io \
  --field ref=<tag or commit> --field commit=<its full commit SHA> --field rollback=true
```

The run builds it, with a warning for each check it let through. Use it only
on purpose, and never below 2.4.0 (on dev, below v2.4.0's commit), nor below
any later release that raises the storage version again. Normal deploys
then go on forward from the rolled-back build.

The check doesn't stop whoever holds the dispatch token, who can send
`rollback: true` too. It makes going back deliberate, and visible in the
run's inputs and warnings. A deleted run hides that, but the build's
attestations stay in Sigstore's public log, and `verify-site.sh` warns when
the live site isn't the newest build.

## Checking a live site

```shell
scripts/verify-site.sh https://<org>.github.io <org>/<org>.github.io --rebuild
```

It checks that no other repository of the organization has Pages, that the
manifest names this repository and a commit on `main` (or a release tag's
commit), that every file matches the manifest and is attested by the hosting
repository's `deploy.yml` run from `main`, at a commit where it is a copy of
this one, and with `--rebuild` builds the same commit with the same settings
and compares the bytes. It warns, without failing, when the site isn't the
newest build: the latest release tag, or for dev the head of `main`. The full
list is in [docs/verifying.md](../docs/verifying.md#checking-a-live-site).
