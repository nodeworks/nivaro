# Building, releasing, and deploying Nivaro

Nivaro is one repo with two audiences: the **open-source/cloud product** (what
gets built, published, and pushed to Docker Hub) and **your local dev tree**,
which additionally carries deployment-specific extensions under
`api/extensions/` (e.g. `efp-ops`). The rule that keeps them from
intermingling:

> **`api/extensions/*` never enters git or the Docker image.**
> It exists only on dev machines and as a volume mount on deployed instances.

## How the separation works

| Layer | Mechanism |
|---|---|
| Git | `.gitignore` ignores `api/extensions/*` (keeps `tsconfig.json` + `.config.json`). `efp-ops` shows in no diff, survives no `git add .`. |
| Docker build | `.dockerignore` excludes `api/extensions` — the build context never contains it, so no image layer can either. |
| API build | `api/tsconfig.json` includes `src/**` only; extensions compile separately (`pnpm --filter @nivaro/api run typecheck:extensions`, dev-only). |
| Runtime | `loader.ts` resolves `/app/api/extensions` and **silently skips it when absent**. A deployment that wants extensions volume-mounts them there. |
| Cloud | `api/cloud-extensions/` is a separate injected dir (see `inject-cloud-extensions.sh`) — unrelated to third-party extensions. |

Day-to-day you develop exactly as now: full repo, efp-ops live under
`api/extensions/efp-ops`, `pnpm dev` loads it. Nothing to toggle.

## The four releases

All four are tag-driven: a local script bumps + tags + pushes, and a GitHub
workflow does the publish. Secrets live in the GitHub repo settings
(`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`, `NPM_TOKEN`, Vercel token).

| What | Command | Tag | Workflow → destination |
|---|---|---|---|
| SDK (`@nivaro/sdk`) | `pnpm sdk:release patch\|minor\|major` | `@sdk-x.y.z` | `publish-sdk.yml` → npm |
| Extension kit (`@nivaro/extension-kit`) | `pnpm kit:release patch\|minor\|major` | `@kit-x.y.z` | `publish-kit.yml` → npm |
| React (`@nivaro/react`) | `pnpm react:release …` | `@react-x.y.z` | `publish-react.yml` → npm |
| www (marketing + docs site) | `pnpm www:release …` | `@www-x.y.z` | `vercel.yml` → Vercel |
| Nivaro app image | `pnpm release …` | `v x.y.z` + `@app-x.y.z` | `docker-hub.yml` → `nodeworks/nivaro:x.y.z` + `:latest` |

`sdk:release` and `www:release` run `sync-docs` first, so the SDK README and
`www/docs.html` are regenerated from `admin/src/docs` before the tag.

Typical order when everything changed: `sdk` → `react` (react pins the sdk) →
`release` (app image) → `www`.

## Deploying with third-party extensions

A deployment repo (separate from this one) pulls the published image and
volume-mounts compiled extensions — the image itself stays generic:

```yaml
services:
  nivaro:
    image: nodeworks/nivaro:1.4.2          # pin the released version
    env_file: .env
    volumes:
      # compiled extension (index.js — prod loads .js, not .ts)
      - ./my-extension:/app/api/extensions/my-extension:ro
```

- Extensions must be **compiled** for the mount — the loader imports `.js`
  in production (node16 resolution: imports need explicit `.js` extensions;
  `api/extensions/tsconfig.json` has the right settings).
- Extension mail templates ride along automatically
  (`<extension>/templates/mail` — an extension `base.liquid` rebrands every
  outgoing email).
- Deployment-specific env belongs in the deployment repo, never here.

## What the public image/repo must never contain

- `api/extensions/*` (this doc's whole point).
- `.env*` (dockerignored; `.env.example` allowed).
- Anything matched by `.dockerignore` (`*.md` files, `.claude/`, IDE config
  are already excluded from the image).

Internal working docs are gitignored and untracked (`CLAUDE.md`,
`docs/claude/`, `docs/superpowers/`, `PRODUCT.md`/`DESIGN.md`) — they stay on
dev machines only.

**Publishing to GitHub**: never push this repo's history directly. Run
`scripts/publish-github.sh` — it builds a disposable mirror clone, strips the
internal paths from every commit with git-filter-repo, redacts leaked strings
from historical blobs, verifies the result with full-history leak greps, and
(with `--push <git-url>`) force-pushes branches + tags to the public remote.
Commit your work first (the mirror reflects committed history only), then
rerun it for every publish.

## Releasing from the admin (local development)

On a development API running from this checkout with `release-chain.config.json`
present, the Environments page shows a **Release** card. **Show plan** runs
`node scripts/release-chain.mjs --events` (touches nothing) and lists what the
release would cut. **Release** runs it with `--go` as a detached process whose
log lives under `.release-runs/<id>.log`; the card shows the seven stages
(preflight → release → publish → artifacts → frontends → deployments → verify),
the live log, a Cancel while running and a **Resume from <stage>** after a
failure (`--from <stage>`). One run at a time. The run survives the dev API
restarting because its state is read from the process id and the log's last
`### DONE` / `### FAILED` line, never from memory. Deployed instances never
show the card — the release needs this machine's checkouts and credentials.

A Cancel past `publish` may already have pushed: the image, npm packages or
frontend commits it sent cannot be undone from the card. A stuck
`.release-runs/current.lock` can be deleted when nothing is running. A `lost`
run's log is `.release-runs/<id>.log`; resume it from a terminal with
`node scripts/release-chain.mjs --go --from <stage>`.
A chain started from a terminal is invisible to the card's lock — do not click
Release while one runs.

**Pinned deployments.** A deployment entry with `"version_file"` (e.g.
`".docker/staging-version"`) gets the release version written into that file
and committed with the deploy push. The deployment's own CI reads it to pick
the image tag, so a deploy runs exactly the image the chain saw on the
registry (never a stale `:latest`) and `/api/preflight` reports the tag as
pinned. EFP staging does this; a `NIVARO_VERSION` CI variable still overrides
it for a manual rollback.

**The post-deploy gate (#1045).** Answering the new version only proves the
process booted. For every verify entry whose URL ends in `/api/version`, the
verify stage then runs `scripts/release-gate.mjs` against that API:

- `GET /api/ready` must be 200 — boot finished, no pending migrations, required
  extensions loaded, database and Redis answering;
- `GET /api/preflight` must not fail, `POST /api/ops-runtime/smoke?strict=1`
  must pass, and the readiness score must be no lower than the snapshot taken
  just before the deployments were pushed (one re-read after a minute, in case a
  cache was still warming).

The last three need an admin gate token. The card hands the chain the token
each API component holds in the Environments registry (by base URL, in the
child's environment, never its arguments); a terminal run reads
`"gate": { "token_env": "NAME" }` on the verify entry. Without a token only
`/api/ready` is checked and the log says so; a token the API refuses fails the
stage (`### FAILED at verify`) — fix the token, then **Resume from verify**.
`"gate": { "readiness_tolerance": 5 }` allows a small drop; `"gate": false`
turns the gate off for one entry. The pre-deploy snapshot is kept in
`.release-runs/gate-before.json`, so a resume from `verify` still compares
against it.

The staging deploy job runs the same checks on the host
(`efp-nivaro/.docker/deploy-gate.sh`): `/api/ready` always (a failure on the
database or Redis alone is warned, not rolled back — the previous image would
meet the same database), and preflight + strict smoke + the readiness score
when the `STAGING_GATE_TOKEN` CI variable is set. A readiness drop is only
warned there; the release chain's verify stage is what fails on it.

**Stage timing (#1046).** When a run finishes, its per-stage durations are
read from the log's `@@event` lines and stored on `.release-runs/<id>.json`
(`timings`); older runs are filled in the first time the card lists them. The
card's **Stage timing** section lists the last releases with each stage's time,
a trend line per stage, and the slowest stage of each release highlighted
(`GET /api/release/timings`). Stages overlap (artifacts waits on the image
while frontends pin), so the columns do not add up to the total.

### Promoting to production

The release chain stops at staging. **Promote to production** on the same card
lists the version staging runs now plus the last versions a finished, verified
release run took there. Picking one runs `node scripts/promote-production.mjs
--version <v> --events` (plan only) and shows what production runs, the
migrations it will run, and anything that blocks. Typing the version back starts
the real run (`--go`, same lock and detached-process rules as a release):

1. **check** — production promotion is switched on, the image tag is on Docker
   Hub with a digest (pinned as line 2 of the pin file; a registry answer
   without one blocks — production deploys by digest), the deploy commit that took the version
   to staging exists, staging answered with it, the portal commit staging serves
   is on its main branch, and a GitLab token is present.
2. **push** — in throwaway worktrees: the API deployment repository's
   `production` branch gets the deploy commit merged and the pin file
   (`.docker/nivaro-version`: version, then digest) written; the portal
   repository's `production` branch gets the commit staging serves merged. Both
   pushed. The portal's pipeline builds its image from that commit.
3. **deploy** — both production deploy jobs are manual; the promotion plays them
   through the GitLab API in order: the API first (canary runs the migrations,
   gates check every task, failure rolls back), then the portal (its script
   refuses an API older than the build). A failed job ends the promotion.
4. **verify** — once `ROUTE_PRIORITY` ≥ 3 in the deployment repository's
   `.docker/production.conf` (the stacks own the public hostnames), the public
   URLs must answer the release twice. Before that the legacy apps serve them,
   and the deploy jobs' gates are the verification.

**First production deploy:** tick *First production deploy (bootstrap)* — the
API job runs with `GATE_MODE=bootstrap`, skipping the checks that need the gate
account (it cannot exist before that deploy's canary has migrated). Afterwards,
create the gate account and set `NIVARO_GATE_TOKEN` on the deployment project.

**The switch.** `"enabled": true` in the `production` block of
`release-chain.config.json` arms promotion; while it is false (until cutover)
the plan still renders but `--go` stops at *check* and nothing is pushed.

Configuration: the `production` block of `release-chain.config.json` (see
`release-chain.config.example.json`) — `path`, `branch`, `pin_file`,
`route_conf`, `gitlab {api, project}`, `verify`, and an optional `frontend`
block for a separately deployed portal. The GitLab token is the one the
Environments registry holds for the deployment repository (the card passes it
in the child's environment; from a terminal, set `GITLAB_TOKEN`). The
**Production** tier on `/environments` shows both production pipelines.

### Runbooks

Below the Release card, **Runbooks** lists the long operator scripts extensions
declare (`runbooks` on the extension's export — EFP's go-live chain is one).
A target is typed (for the go-live chain, `DB_DATABASE`), a **Dry run** comes
first, and **Run** stays disabled until a dry run of that target finished in the
last 24 hours; the target is typed back to start. Runs live under
`.runbook-runs/`, survive the API restarting, and can be cancelled or resumed
at the step that failed.

## SDK coverage

`pnpm --filter @nivaro/api run sdk:coverage` registers the route tree in
process, reads every `cmd('METHOD', '/path')` under `packages/sdk/src`, and
lists the routes no command reaches (grouped by family, with the browser-only
and operator-only families counted apart) and the commands that reach no
route. Report only; the preflight stage prints its one-line summary. Run it
after adding routes a script should be able to call, and before an SDK
release — the first run found three documented commands that answered 404.
