# Nivaro

Headless CMS — Fastify REST + GraphQL API, React admin UI, TypeScript SDK, and a single-image Docker release.

[Website](https://nivaro.dev) · [SDK on npm](https://www.npmjs.com/package/@nivaro/sdk) · [Docker Hub](https://hub.docker.com/r/nodeworks/nivaro)

---

## Features

- **RBAC** — roles, policies, per-field permissions, workspace isolation
- **Microsoft OIDC** — PKCE login, AD group sync
- **Workflow Engine** — state machine with role-gated transitions, history
- **Pipeline / Owner Matrix** — multi-dimensional ownership per workflow state
- **GraphQL API + Subscriptions** — auto-built from metadata registry
- **Real-time** — Socket.io + Redis adapter (notifications, item events)
- **Extension System** — drop a folder into `api/extensions/`, no restart needed
- **Flow Extension API** — extensions register custom operation types and trigger types; appear in the flow editor with schema-driven config UI
- **External API Flow Operation** — call any configured External API or custom URL from a flow, with SSRF protection
- **Inngest Jobs** — durable background functions (cron + event-triggered)
- **AI Features** — field generation and record summarization via Claude
- **Dashboards & KPI Builder** — drag-and-drop widget grid
- **Audit Log & Revisions** — full snapshot + delta per mutation
- **Bulk Actions** — delete, field update, workflow transition across selections
- **Comments & Mentions** — per-record threaded comments with @mention notifications
- **Submission Forms** — public-facing forms with token auth, rate limiting, password protection
- **Field Watches & Subscriptions** — granular change notifications
- **Data Import Queue** — CSV import with live progress via Socket.io
- **SLA Tracking** — business-hours elapsed time, warning/breach alerts
- **Alert Engine** — threshold-based alerts with cooldown + in-app/email delivery
- **Rollup Computed Fields** — aggregate (sum/count/avg/min/max) of related items; recursive tree rollups via CTE
- **User Delegation** — out-of-office delegation with expiry; pipeline engine substitutes delegate as owner
- **Field Rules** — per-collection cascading defaults: when field A = X, auto-set field B = Y; applied on save and real-time in the item editor
- **Dynamic Attributes (EAV)** — define custom attributes per collection at runtime without migrations; stored in `nivaro_attribute_definitions` + `nivaro_attribute_values`
- **Multi-Workspace** — collections and roles scoped per workspace
- **Custom Queries** — named, parameterized SQL endpoints with caching
- **External API Configs** — managed credentials, live test panel
- **Tree & Hierarchy** — any collection can be tree-enabled; recursive CTE queries, tree browser, drag-to-reparent, breadcrumb navigation
- **Org Chart View** — tree collections render as a zoomable, collapsible org chart with click-to-open node cards
- **Reorder Siblings** — drag handle in tree view persists sibling sort order (order_field-backed)
- **Breadcrumb Path Column** — opt-in materialized `path`/`depth` columns per tree collection; `LIKE '/x/%'` subtree queries, one-click rebuild
- **Inherited Field Values** — mark fields inheritable and tree descendants resolve them from the nearest ancestor, with Inherited/Overridden chips in the editor
- **Tree Permissions** — subtree-scoped role rules (allow/deny per action) that restrict reads, updates, and deletes below a node
- **At-Risk Flagging** — per-collection risk rules with cross-field `{{field}}` expressions; red/amber row highlighting and an "At risk" filter chip
- **Queue SLA Timers** — live green/amber/red SLA countdown column in the collection browser for workflow-bound items
- **Conditional Branching** — pipeline transitions carry field conditions; only matching paths are offered and the server revalidates on execute
- **Multi-collection Hierarchy** — define named trees spanning multiple collections, one per level, linked by FK columns; each level keeps its own independent schema, workflows, and RBAC
- **Reports, Schema Snapshots, Computed Fields**
- **Data Export** — export any collection to CSV, JSON, or Excel with filters and field selection
- **Draft / Publish States** — per-collection draft/review/published workflow with submit-for-review action
- **Content Scheduling** — queue field updates, workflow transitions, and publish actions to execute at a future time
- **Conditional Field Visibility** — show/hide fields based on other field values, evaluated in real time
- **Field Locking Rules** — make fields read-only when record conditions are met; enforced in UI and server-side
- **Field Dependencies and Cascading Values** — changing one field clears or recalculates dependent fields automatically
- **Remote Option Sources** — dropdown fields load options from External APIs at runtime
- **Computed Default Values** — formula-based defaults evaluated on create (TODAY(), CONCAT(), UPPER(), etc.)
- **Field Validation Rules** — custom validation beyond required/type: min/max length, regex, unique, email, url, date ranges
- **Cross-Record Defaults** — copy field values from a related record when creating a new item
- **Duplicate / Clone Item** — single-call deep clone with optional field overrides
- **Rollback to Revision** — restore any item to a previous revision snapshot from the revision history panel
- **Polymorphic Relations (M2A) Builder** — relate a field to items from multiple collections via a junction table
- **Virtual Collections** — SQL-view-backed read-only collections; validate SQL and query via API
- **Field Groups / Tabs** — organise fields into collapsible sections or named tabs in the item editor
- **Repeater Fields** — ordered arrays of structured sub-objects stored as JSON, with schema-driven sub-forms
- **Rich Text / WYSIWYG Field Type** — ProseMirror/TipTap portable JSON content stored in standard text columns
- **Field Change History Graph** — sparkline of a field's values over all revisions; hover for timestamp and author
- **Collection Presets** — one-click starter kits for Blog, CRM, Project Tracker, and Event Manager
- **Multi-Language Field Values (i18n)** — per-locale values for translatable fields via field-translations API
- **Record Templates** — save and apply named sets of field defaults when creating new items
- **Line Items / BOM Field Type** — ordered child rows stored as proper table rows; supports rollup aggregation and reusable templates
- **% Complete Field Type** — integer field with progress bar UI; colour-coded thresholds in browser and editor
- **Addendum / Amendment Records** — formal amendment records with draft/submitted/approved/rejected lifecycle, cost and timeline impact tracking, and immutable change order log
- **Multi-Database Support** — MSSQL, PostgreSQL, or MySQL via `DB_CLIENT`; optional read replica routing (`DB_READ_HOST`)
- **Two-Factor Authentication** — self-service TOTP enrolment with QR code; enforced at login
- **SAML 2.0 SSO** — env-configured service provider with enforced signed responses and assertions
- **Named API Keys** — `nvk_` scoped tokens with expiry, IP allowlist, and per-key rate limits; sha256-hashed at rest
- **SCIM 2.0 Provisioning** — automatic user provisioning/deprovisioning from Azure AD / Okta
- **Field Encryption at Rest** — per-field AES-256-GCM, transparent to the API and admin UI
- **Row-Level Workspace Isolation** — optional `workspace_id` column scopes item rows per workspace
- **Usage Quotas & Workspace Templates** — per-workspace limits with usage meters; snapshot a workspace and replay it into new ones
- **Developer Tooling** — schema → TypeScript codegen, OpenAPI 3.1, Postman/Bruno exports, in-browser SDK playground
- **Webhook Reliability** — per-delivery log with retry, event replay, HMAC-signed payloads, and a dead letter queue
- **Rate Limiting** — Redis-backed fixed window with `X-RateLimit-*` headers
- **CDC Event Stream** — admin SSE stream of every item mutation
- **GraphQL Persisted Queries** — execute by id or Apollo-style APQ hash
- **Flow Versioning & Environment Sync** — flow snapshots with restore; non-destructive schema promotion between environments
- **Live Schema Migrations** — safe column type changes (TRY_CAST-validated) and field renames from the Data Model
- **Extension Marketplace** — one-click extension installs from a configurable registry (SSRF-guarded)
- **Cloud Storage** — S3 / Cloudflare R2 / Azure Blob adapters, presigned uploads, CDN URLs
- **Image Transformations** — on-the-fly resize/crop/format/quality via sharp, cached
- **File Expiry & PDF Generation** — auto-pruned temporary files; Liquid-templated PDF rendering per record
- **ERP Submission Tracking & Sync Jobs** — push-status lifecycle per record; bi-directional scheduled syncs with conflict strategies and a no-code API connector
- **Parallel Workflow Branches** — split/join with auto-join when all branches complete
- **Cross-Collection Triggers** — rule-driven writes into other collections with `{{field}}` templates and a recursion guard
- **Tasks & Approval Chains** — per-record assignments and sequential sign-off with decision log
- **Item Locking & Presence** — soft edit locks with heartbeat; live viewer indicators
- **Notifications Center & SMS/Push Channels** — full inbox page; Twilio SMS delivery; Slack/Teams Adaptive Card actions with signed Approve/Reject buttons
- **Global Search (Cmd+K)** — command palette across collections, pages, and actions
- **Saved Views** — named filter/sort/column sets, private, shared, or role-scoped
- **AI Import Mapping & Query Builder** — Claude-suggested CSV column mapping; natural-language → filter DSL
- **Semantic Search** — vector search via Voyage AI (or local fallback) over collection content
- **Page Builder** — low-code internal pages from table/KPI/markdown/iframe widgets, published at `/p/:slug`
- **Rule & Formula Builders** — structured condition/action editor and token-chip formula editor with raw toggles
- **API Analytics & Health Dashboard** — p50/p95 latency, error rates, and live subsystem health
- **Data Quality & Issue Log** — per-collection quality rules with run history; central operational issue triage
- **Privacy & Retention Policies** — configurable inactivity-based user redaction/deletion with dry-run preview, cron scheduling, PII field selection, exclusion lists, and full run audit log; redacted users automatically excluded from all pickers
- **AI Content Validation** — natural-language rules per collection, soft warn or hard block (server-enforced 422)
- **AI Duplicate Detection** — embedding-based similarity check with pre-create warning panel and tunable threshold
- **Anomaly Detection Alerts** — statistical (stddev) detection mode on alert definitions; notifications carry z-scores and optional Claude explanations
- **Digest Emails** — per-subscription Instant/Daily/Weekly delivery; daily 08:00 and Monday weekly digest crons
- **Row-Level Security** — per-policy row filters with `$CURRENT_USER` / `$CURRENT_ROLE` tokens; enforced for read/update/delete everywhere the items service runs
- **Zero-Downtime Migrations** — advisory-locked startup migrations for multi-replica deploys plus graceful SIGTERM drain
- **Headless E-Commerce Primitives** — `ecommerce` preset with products, orders, inventory ledger, and a pre-wired low-stock alert
- **Embeddable Widget SDK** — token-gated public list/form widgets via a one-line script tag; XSS-safe, no iframes
- **Zapier / Make Integration** — REST-hook triggers, create/update actions, and discovery endpoints under `/api/zapier`, authenticated with `nvk_` API keys
- **Public API Docs Site** — static `www/api-reference.html` explorer regenerated from any instance via `pnpm docs:api`
- **Full SDK Coverage** — ~175 typed SDK commands spanning every feature area, explorable in the in-browser SDK playground

---

## Stack

| Layer | Choice |
|---|---|
| API | Fastify v5 (TypeScript) |
| Database | Knex + MSSQL (tedious) |
| Auth | openid-client PKCE — Microsoft OIDC |
| Sessions | Redis (ioredis) + @fastify/session |
| Real-time | Socket.io + @socket.io/redis-adapter |
| Jobs | Inngest self-hosted (Postgres + Redis) |
| Admin UI | React 19 + Vite 6 + shadcn/ui (Tailwind v3) |
| SDK | `@nivaro/sdk` — ESM, fully typed |
| Linter | Biome v2 |
| Packages | pnpm v11 workspaces |

---

## Development

### Requirements

- Node.js 22+
- pnpm 11+
- Redis (local or via Docker)
- MSSQL database

### Setup

```bash
cp .env.example .env
# fill in DB_*, OIDC_*, SESSION_SECRET

pnpm install
pnpm migrate
pnpm dev
# API → http://localhost:3055
# Admin → http://localhost:3056
```

`pnpm dev` starts Redis (Docker), Inngest dev server, API, and admin concurrently.

### Full stack via Docker

```bash
pnpm dev:docker        # build + start all containers
pnpm dev:docker:down   # stop and remove
```

### Commands

| Command | Description |
|---|---|
| `pnpm dev` | Redis + Inngest + API (:3055) + admin (:3056) |
| `pnpm dev:api` | API only |
| `pnpm dev:admin` | Admin UI only |
| `pnpm dev:redis` | Redis in Docker on :6379 |
| `pnpm dev:inngest` | Inngest dev server on :8288 |
| `pnpm dev:docker` | Full stack via Docker Compose |
| `pnpm dev:www` | Static www site via browser-sync on :3057 |
| `pnpm build` | Compile API (tsc) + build admin (vite) |
| `pnpm migrate` | Run pending DB migrations |
| `pnpm migrate:rollback` | Roll back last migration batch |
| `pnpm check` | Biome lint + format check |
| `pnpm check:fix` | Auto-fix formatting and lint |

---

## Releasing

All three release flows use **git tags** to trigger GitHub Actions.

### App image (`@app-*` → Docker Hub)

```bash
pnpm release patch     # bumps package.json, tags @app-x.x.x, pushes
pnpm release minor
pnpm release 2.3.0     # exact version
```

GitHub Actions builds `Dockerfile.release` and pushes to Docker Hub:

```
nodeworks/nivaro:2.3.0
nodeworks/nivaro:latest
```

### SDK (`@sdk-*` → npm)

```bash
pnpm sdk:release patch
pnpm sdk:release minor
pnpm sdk:release 1.7.0
```

Tags `@sdk-x.x.x` → GitHub Actions publishes `@nivaro/sdk` to npm.

### Website (`@www-*` → Vercel)

```bash
pnpm www:release patch
```

Tags `@www-x.x.x` → GitHub Actions deploys `www/` to Vercel.

---

## Using the Release Image

```bash
docker pull nodeworks/nivaro:latest
```

Minimal `docker-compose.yml` for a consumer project:

```yaml
services:
  nivaro:
    image: nodeworks/nivaro:latest
    ports:
      - "3055:3055"
    env_file: .env
    environment:
      REDIS_URL: redis://redis:6379
      INNGEST_BASE_URL: http://inngest:8288
      INNGEST_EVENT_KEY: ${INNGEST_SIGNING_KEY_DOCKER:-deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe}
      INNGEST_SIGNING_KEY: ${INNGEST_SIGNING_KEY_DOCKER:-deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe}
    volumes:
      - ./extensions:/app/api/extensions
      - uploads:/app/uploads
    depends_on:
      redis:
        condition: service_healthy
      inngest:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: inngest
      POSTGRES_PASSWORD: inngest
      POSTGRES_DB: inngest
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U inngest -d inngest"]
      interval: 5s
      timeout: 3s
      retries: 10

  inngest:
    image: inngest/inngest:latest
    command: inngest start --host 0.0.0.0
    ports:
      - "8288:8288"
    environment:
      INNGEST_EVENT_KEY: ${INNGEST_SIGNING_KEY_DOCKER:-deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe}
      INNGEST_SIGNING_KEY: ${INNGEST_SIGNING_KEY_DOCKER:-deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe}
      INNGEST_POSTGRES_URI: postgres://inngest:inngest@postgres:5432/inngest
      INNGEST_REDIS_URI: redis://redis:6379
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

volumes:
  uploads:
  redis_data:
  postgres_data:
```

Set `INNGEST_SIGNING_KEY_DOCKER` to a real 64-character hex string in production.

See `examples/my-project/` for a full working example with a custom extension.

---

## SDK

```bash
npm install @nivaro/sdk
```

```typescript
import { createNivaro, readItems, createItem, _eq, desc } from '@nivaro/sdk'

const nivaro = createNivaro('https://your-nivaro-host', { token: 'your-static-token' })

// List items with filter + sort
const { data, total } = await nivaro.request(
  readItems('projects', {
    filter: { status: _eq('active') },
    sort: [desc('created_at')],
    limit: 25,
  })
)

// GraphQL
const result = await nivaro.graphql(`
  query { projects(filter: { status: { _eq: "active" } }) { data { id name } total } }
`)

// Realtime
import { createRealtime } from '@nivaro/sdk'
const rt = createRealtime()
rt.connect('https://your-nivaro-host', 'your-token')
const unsub = rt.subscribe('projects', { event: 'update' }, (data) => console.log(data))
```

Full SDK docs: [npmjs.com/package/@nivaro/sdk](https://www.npmjs.com/package/@nivaro/sdk)

---

## Extensions

Drop a folder into `api/extensions/<name>/` with a compiled `index.js`. The loader auto-discovers it on startup — no restart needed for new extensions in dev.

```
api/extensions/
└── my-extension/
    ├── src/index.ts
    ├── index.js         ← compiled output (loaded by Nivaro)
    ├── package.json
    └── tsconfig.json
```

```typescript
// src/index.ts
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'

interface ExtensionContext {
  app: FastifyInstance
  database: Knex
  logger: FastifyInstance['log']
  hooks: {
    before(collection: string | '*', action: string | '*', fn: (...args: unknown[]) => unknown): void
    after(collection: string | '*', action: string | '*', fn: (...args: unknown[]) => unknown): void
  }
  cron: {
    schedule(id: string, expression: string, fn: () => void | Promise<void>): void
  }
  callExternalApi(nameOrId: string | number, options?: Record<string, unknown>): Promise<unknown>
  flows: {
    registerOperation(type: string, definition: Record<string, unknown>): void
    registerTrigger(type: string, definition: Record<string, unknown>): void
    emit(type: string, payload: Record<string, unknown>): Promise<void>
  }
}

export default {
  id: 'my-extension',
  async register({ app, database, logger, hooks, cron, callExternalApi }: ExtensionContext) {
    // Custom route
    app.register(async (f) => {
      f.get('/my-route', async () => ({ ok: true }))
    }, { prefix: '/api' })

    // Hook into mutations
    hooks.after('projects', 'create', async ({ item }) => {
      logger.info({ item }, 'project created')
    })

    // Scheduled job
    cron.schedule('daily-cleanup', '0 2 * * *', async () => {
      await database('my_temp_table').where('created_at', '<', new Date()).delete()
    })
  },
}
```

See `examples/my-project/extensions/` for examples including `example-inngest`, `example-socketio`, `example-ui-plugin`, and `example-flows` (demonstrating the flows API).

---

## Environment variables

Key variables — see `.env.example` for the full list.

| Variable | Description |
|---|---|
| `DB_HOST` / `DB_DATABASE` | MSSQL connection |
| `DB_ENCRYPT=true` | Required for Azure SQL / most cloud MSSQL |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | Required for self-signed or corporate-CA certs with the `tedious` MSSQL driver (it doesn't use the system CA store). Omit in production if your SQL Server has a publicly-trusted cert. |
| `REDIS_URL` | e.g. `redis://localhost:6379` |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Microsoft OIDC |
| `OIDC_REDIRECT_URI` | e.g. `http://localhost:3055/api/auth/callback` |
| `SESSION_SECRET` | 32+ character random string |
| `COOKIE_SECURE=false` | Must be `false` for plain HTTP (Docker default) |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | `local` for dev; real hex for production |
| `INNGEST_SIGNING_KEY_DOCKER` | Production override — prevents `local` leaking into Docker |
| `PUBLIC_URL` | e.g. `http://localhost:3055` |
| `ANTHROPIC_API_KEY` | Optional — enables AI features |

---

## License

MIT — see [LICENSE](LICENSE).
