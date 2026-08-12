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
