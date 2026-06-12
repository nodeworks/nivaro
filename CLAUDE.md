# Nivaro CMS

Standalone headless CMS. Designed as a generic product. **Nivaro** = the architectural base.

Features: metadata registry, schema editor (collections/fields/relations via admin UI), RBAC, Microsoft OIDC, plugin/extension system, React admin UI, TypeScript SDK, Workflow / State Machine Engine, Pipeline / Owner Matrix Engine, revision history, real-time notifications (Socket.io), GraphQL API + subscriptions, External API configs, Bulk Actions, Comments & Mentions, Computed Fields, Dashboard & KPI Builder, Audit Reports, Microsoft Integration Pack, AI Features (Claude), Multi-Workspace, Public Submission Forms, Field-Level Watch / Changelog, Notification Subscriptions, Data Import Queue, SLA Tracking, Alert & Threshold Engine.

---

## Auto-documentation rule

After every new feature or enhancement:
1. Check if it needs a new doc section in `admin/src/docs/sections/` and add one if applicable.
2. Export the new section from `admin/src/docs/index.ts` and add it to the relevant nav group.
3. Add matching content + nav item to `www/docs.html` (same nav group, same section ID with `s-` prefix).
4. Update `CLAUDE.md` system tables, routes table, or gotchas if the feature introduces new tables, routes, or non-obvious behavior.
5. Update `README.md` feature list if the feature is user-facing.

This rule applies automatically — do not wait for the user to ask for docs updates.

---

## Roadmap (all ✅ Done)

1 Workflow Engine · 2 Pipeline/Owner Matrix · 3 GraphQL+Subscriptions · 4 In-App Notifications · 5 External API Config · 6 Bulk Actions · 7 Comments & Mentions · 8 Computed Fields · 9 Dashboard & KPI Builder · 10 Audit Reports · 11 Microsoft Integration · 12 AI Features · 13 Multi-Workspace

**Extended features (migrations 020–025):**
14 Public Submission Forms · 15 Field-Level Watch / Changelog · 16 Notification Subscriptions · 17 Data Import Queue · 18 SLA Tracking · 19 Alert & Threshold Engine

---

## Monorepo structure

```
nivaro/
├── api/src/
│   ├── index.ts          Entry point — migrations then server
│   ├── server.ts         Fastify factory; serves admin SPA at / in production
│   ├── config.ts         Zod-validated config from .env
│   ├── types.ts          Shared interfaces + Fastify augmentations (req.user, req.workspaceId)
│   ├── auth/             oidc.ts (PKCE helpers), session.ts (@fastify/session + Redis)
│   ├── db/
│   │   ├── index.ts      Knex + custom migrationSource (.ts/.js compat)
│   │   └── migrations/   001–043 (tracked in nivaro_migrations)
│   ├── extensions/loader.ts   Auto-loads api/extensions/<name>/index.js; ExtensionContext includes flows.registerOperation/registerTrigger/emit
│   ├── flows/
│   │   └── registry.ts   Extension op/trigger registry; registerOp, registerTrigger, emitTrigger; lazy-imports executor to avoid circular dep
│   ├── hooks/
│   │   ├── activity.ts   Writes nivaro_activity + nivaro_revisions on every item mutation
│   │   ├── registry.ts   before/after hook registry; HookContext includes previousData
│   │   ├── field-watches.ts        registerFieldWatchHooks() + setApp(); diffs previousData on update
│   │   ├── notification-subscriptions.ts  registerNotificationSubscriptionHooks() + setApp()
│   │   ├── sla.ts         registerSlaHooks() + setApp() + checkSlaForInstance()
│   │   └── alerts.ts      registerAlertHooks() + setApp() + evaluateAlerts() + evaluateAlertsForCollection()
│   ├── middleware/
│   │   ├── authenticate.ts   Bearer token + session → req.user; exports authenticate, requireAuth, requireAdmin
│   │   └── workspace.ts      resolveWorkspace — reads x-workspace header → user.current_workspace → default
│   ├── graphql/          pubsub.ts, resolvers.ts, scalars.ts, types.ts (thunks; exports ALL_DOMAIN_TYPES)
│   ├── plugins/          cron.ts, graphql.ts, inngest.ts, redis.ts, socketio.ts
│   ├── routes/
│   │   ├── index.ts      Registers all routes under /api prefix
│   │   ├── activity.ts, auth.ts, collections.ts, data-model.ts, extensions.ts
│   │   ├── external-apis.ts  CRUD + /:id/test; secrets masked on GET
│   │   ├── files.ts, flows.ts, health.ts, items.ts, mail.ts
│   │   ├── flow-registry.ts  GET /flows/registered-operations + /flows/registered-triggers (auth-gated)
│   │   ├── notifications.ts, pipelines.ts, revisions.ts, roles.ts
│   │   ├── schema.ts, schema-snapshot.ts, settings.ts, users.ts, workflows.ts
│   │   ├── ai.ts         POST /ai/generate, /ai/summarize — admin only; reads key from env then DB fallback
│   │   ├── blackout-dates.ts, comments.ts, custom-queries.ts, dashboards.ts
│   │   ├── presets.ts, reports.ts, rules.ts, webhooks.ts
│   │   ├── field-rules.ts  CRUD (admin) + GET ?collection= + POST /evaluate (auth) — per-collection inline field defaults
│   │   ├── workspaces.ts CRUD + /:id/switch; resolveWorkspace scopes collections + roles
│   │   ├── submission-forms.ts  Admin CRUD + public GET/POST /public/:token; scrypt password; rate-limit per IP
│   │   ├── field-watches.ts     Admin CRUD + /subscribe /unsubscribe; can() guard on subscribe
│   │   ├── notification-subscriptions.ts  Own CRUD + admin/all, admin/stats
│   │   ├── imports.ts      requireAdmin; fire-and-forget processImportJob; blocks nivaro_* tables
│   │   ├── sla.ts          Admin rule CRUD + GET /status/:collection/:item + POST /status/batch {collection, ids}
│   │   ├── alerts.ts       Admin definitions CRUD + subscriptions (authenticated) + log + POST /evaluate
│   │   ├── tree.ts              GET/POST/PATCH/DELETE /tree-configs (+ POST :id/rebuild-paths); GET /tree/:collection/nodes|nested|:id/ancestors|descendants|children; PATCH :id/move, :id/reorder
│   │   ├── tree-permissions.ts  Admin CRUD /tree-permissions — subtree role grants (read/update/delete/*)
│   │   ├── at-risk.ts      Admin rule CRUD /at-risk/rules + GET /rules/active + POST /evaluate + GET /summary
│   │   ├── retention.ts    Admin CRUD /retention + POST /:id/run (?dry_run=true) + GET /:id/runs
│   │   ├── hierarchy.ts    Config CRUD + /hierarchy/:id/tree|nodes|node/:col/:id/children|ancestors
│   │   └── attributes.ts   Dynamic EAV: admin definition CRUD (/attribute-definitions) + value GET/PATCH (/attributes/:collection/:itemId)
│   └── services/
│       ├── activity.ts     logActivity() → number | null
│       ├── collections.ts, external-apis.ts, files.ts, flow-executor.ts
│       ├── items.ts        Generic CRUD; captures previousData for hooks
│       ├── mail.ts         sendMail() + sendRawMail() via nodemailer + LiquidJS; reads SMTP from nivaro_settings (DB-first, env fallback)
│       ├── sms.ts          sendSms(to, body) — routes to configured provider (Twilio/SNS/Vonage/Sinch/MessageBird); reads from nivaro_settings
│       ├── microsoft.ts    MS Teams webhook + AD group sync helpers
│       ├── permissions.ts  can(), getAllowedFields()
│       ├── pipeline-engine.ts  Shared pipeline helpers (also used by GQL resolvers)
│       ├── revisions.ts    writeRevision(), listRevisions(), computeDelta()
│       ├── schema-builder.ts  buildGraphQLSchema() from nivaro_collections/fields
│       └── users.ts        findOrCreateFromOIDC, updateUser
│
├── admin/src/
│   ├── globals.css       Tailwind base + CSS vars (nvr-cyan, nvr-navy); dark mode via .dark class
│   ├── components/
│   │   ├── ui/                    shadcn/ui (includes Sheet)
│   │   ├── bulk-action-bar.tsx    Selected-rows bar: Delete, Update Field, Transition
│   │   ├── field-picker.tsx       Recursive relation-traversing picker; PickedField includes relatedCollection
│   │   ├── notification-bell.tsx  Socket.io bell; compact?: boolean (sidebar footer)
│   │   ├── pipeline-owner-matrix.tsx  getCellResult() specificity; inherited/override states
│   │   ├── pipeline-panel.tsx     Transitions with same group_label → DropdownMenu
│   │   ├── pipeline-skip-criteria.tsx  fieldRelations stores { collection, displayField }
│   │   ├── revisions-panel.tsx    Sheet sidebar; delta table for updates, JSON for create/delete
│   │   ├── theme-switcher.tsx     Light/dark/system toggle
│   │   └── workflow-panel.tsx     State + transitions on item edit; returns null if unbound
│   ├── layouts/AppLayout.tsx
│   │   — Sidebar: primary nav + Automation + System sections
│   │   — Footer strip: NotificationBell(compact) + ThemeSwitcher + collapse toggle
│   │   — Workspace switcher popover (bottom of sidebar)
│   ├── lib/
│   │   ├── api.ts        Axios instance; WORKSPACE_KEY export; request interceptor injects x-workspace from localStorage
│   │   ├── auth.tsx      AuthContext + useAuth(); writes current_workspace to localStorage on login
│   │   ├── relations.ts  renderDisplayTemplate(), extractTemplateFields(), findM2ORelation()
│   │   ├── useSettings.ts  Settings singleton hook
│   │   └── utils.ts      cn(), formatDate(), formatRelative(), formatNumber(), formatFileSize(), titleCase()
│   └── pages/
│       Activity, ActivityDetail, ApiDocs, BlackoutDates, CollectionBrowser, Collections,
│       CustomQueries, CustomQueryEdit, Dashboard, DashboardEdit, Dashboards, DataModel,
│       Docs, Extensions, ExternalApiEdit, ExternalApis, Files, FlowEdit, Flows,
│       GraphQLExplorer, ItemEdit, Login, PipelineEdit, Pipelines, Profile, Reports,
│       Roles, RuleEdit, Rules, SchemaSnapshot, Settings, TableEditor, UserEdit, Users,
│       WebhookEdit, Webhooks, WorkflowEdit, Workflows, Workspaces,
│       SubmissionForms, SubmissionFormEdit, FieldWatches, NotificationSubscriptions,
│       Imports, ImportJobPage, SlaRules, Alerts, AlertEdit
│
├── sdk/src/              createNivaro() client + filter helpers + realtime Socket.io client
├── react/src/            @nivaro/react — useNivaroForm hook + NivaroForm/NivaroField components (zero CSS, headless)
├── scripts/release-sdk.mjs
├── examples/my-project/  docker-compose, .env.example, extensions/ (example-inngest, example-socketio, example-ui-plugin, example-flows)
├── .gitlab-ci.yml        build_production (main) + publish_sdk (@sdk-* tags)
├── docker-compose.yml    Dev: API + admin + Redis + Inngest + Postgres
├── Dockerfile.release    Single image: API + admin SPA
└── biome.json            Formatter + linter config
```

---

## Commands

```bash
pnpm dev              # Redis → Inngest + API (3055) + admin (3056) concurrently
pnpm dev:api / dev:admin / dev:redis / dev:inngest
pnpm dev:docker       # Full stack via Docker Compose
pnpm build            # tsc + vite build
pnpm migrate          # Run pending migrations
pnpm migrate:rollback

# Releases
pnpm sdk:release patch|minor|major|<version>
pnpm release:build / release:tag / release:push

# Code quality
pnpm check / check:fix   # Biome
pnpm dead-code / dupes / health  # Fallow
```

---

## Tech stack

| Layer | Choice |
|---|---|
| API | Fastify v5 (TypeScript) |
| DB | Knex + MSSQL (tedious); nivaro_ prefix |
| Cache/sessions | Redis (ioredis); sess:<id> keys |
| WebSockets | Socket.io + @socket.io/redis-adapter |
| Job queue | Inngest self-hosted (Postgres + Redis) |
| Auth | openid-client PKCE; Microsoft OIDC |
| Mail | nodemailer + LiquidJS |
| Files | multer + local disk |
| Admin UI | React 19 + Vite 6; dev proxy /api → :3055 |
| Components | shadcn/ui (Radix + Tailwind v3); nvr-cyan, nvr-navy |
| State | Tanstack Query v5 |
| Routing | React Router v7 |
| Linter | Biome v2 — 2sp indent, 100 col, **no semicolons**, **single quotes** (JS + JSX), **no trailing commas**, `noExplicitAny` off, `noConsoleLog` warn |
| Packages | pnpm v11 workspaces: @nivaro/api, @nivaro/admin, @nivaro/sdk, @nivaro/react |

---

## Environment

`.env` at repo root; loaded in `api/src/config.ts` via `import.meta.url`. Do NOT use `--env-file` — breaks tsx watch.

```
DB_HOST / DB_DATABASE / DB_ENCRYPT=true / DB_TRUST_SERVER_CERT=true
NODE_TLS_REJECT_UNAUTHORIZED=0
REDIS_URL=redis://localhost:6679   # non-standard port in local dev
OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_REDIRECT_URI
SESSION_SECRET                     # 32+ chars
COOKIE_SECURE=false                # must be false for plain HTTP (Docker default)
MAIL_FROM / SMTP_HOST / SMTP_USER / SMTP_PASS
ANTHROPIC_API_KEY                  # optional; AI routes also fall back to nivaro_settings.anthropic_api_key
INNGEST_EVENT_KEY=local / INNGEST_SIGNING_KEY=local   # local dev (bypasses cloud)
INNGEST_SIGNING_KEY_DOCKER         # Docker: must be real 64-char hex; compose uses fallback if unset
MIGRATION_SAFE_MODE=true           # optional: per-dialect advisory lock before migrations (multi-replica)
MIGRATION_LOCK_TIMEOUT_MS=60000    # optional: how long replicas wait for the migration lock
PUBLIC_URL=http://localhost:3055
ADMIN_URL=http://localhost:3056    # same as PUBLIC_URL in release image
```

---

## Database — system tables

All `nivaro_` prefixed. Migrations tracked in `nivaro_migrations`.

**FK type rule:** `nivaro_roles.id`, `nivaro_users.id`, `nivaro_workflow_templates.id` are all `uniqueidentifier` — FK columns referencing them must be `t.uuid()`, never `t.integer()` (MSSQL error 1778).

| Table | Purpose |
|---|---|
| `nivaro_roles` | Role definitions (admin_access, app_access); workspace-scoped; ui_permissions (JSON text — array of disabled route paths) |
| `nivaro_users` | CMS users; external_id (OIDC), static_token, current_workspace, manager_id (FK self), delegate_id (FK self), delegate_expires_at, is_out_of_office |
| `nivaro_policies` | Per-role permissions: collection + action + optional field list |
| `nivaro_sessions` | Session store (also Redis-backed) |
| `nivaro_collections` | Metadata registry; workspace-scoped |
| `nivaro_fields` | Field metadata — type, interface, hidden, required, sort, computed_formula, computed_type, group_key, visibility_rules, dependency_config (includes cascade_filters — cascade option filtering between M2O fields — see gotchas), validation_rules, lock_condition, default_formula, cross_record_defaults, remote_options_config, repeater_schema, is_translatable, is_inheritable, placeholder nvarchar(500) nullable |
| `nivaro_collections` | Metadata registry; workspace-scoped; draft_publish_enabled bit, is_virtual bit, virtual_sql nvarchar(max), item_locking_enabled bit (default 1 — toggle in Data Model → Settings), addendums_enabled bit (default 0, opt-in — toggle in Data Model → Settings), picker_filter nvarchar(max) nullable JSON — filter applied to all M2O/M2M pickers targeting this collection |
| `nivaro_picker_exclusions` | Per-record picker exclusion; collection varchar(255) + item_id varchar(255), UNIQUE(collection, item_id); created_by FK → nivaro_users; toggled from ItemEdit header or CollectionBrowser bulk action; items route applies when ?picker=1 |
| `nivaro_external_api_schemas` | Raw imported OpenAPI/Swagger specs per external API; external_api_id FK → nivaro_external_apis CASCADE; title, spec_version, raw_spec nvarchar(max), endpoint_count, imported_at, imported_by FK → nivaro_users |
| `nivaro_relations` | M2O / O2M / M2M / M2A relation definitions |
| `nivaro_settings` | Singleton (id=1); includes anthropic_api_key (masked on GET) |
| `nivaro_file_folders / nivaro_files` | File manager hierarchy + metadata |
| `nivaro_activity` | Audit log; logActivity() returns inserted id |
| `nivaro_revisions` | Full snapshot + delta; FK to activity |
| `nivaro_notifications` | cols: recipient, subject, status ('inbox'|'read'), timestamp, sender, message, collection, item |
| `nivaro_flows / nivaro_flow_operations` | Inngest-backed scheduled flows |
| `nivaro_workflow_templates/states/transitions/bindings/instances/history` | Workflow engine; transitions carry condition_rules (JSON `[{field,op,value}]`) for conditional branching |
| `nivaro_pipeline_owner_groups` | filters (JSON text), sort, priority INT |
| `nivaro_pipeline_owner_group_users` | M2M: owner group → user |
| `nivaro_pipeline_owner_dimensions` | field (dotted path), label, is_row_axis, sort, required |
| `nivaro_pipeline_instance_owners` | Per-record runtime owners |
| `nivaro_workspaces` | id, name, slug, icon, color |
| `nivaro_comments` | Per-record comments; collection, item, user, text |
| `nivaro_comment_mentions` | M2M: comment → user |
| `nivaro_dashboards` | id, name, user, is_shared |
| `nivaro_dashboard_widgets` | type, collection, field, filters, col/row/width/height |
| `nivaro_submission_forms` | uuid PK, name, collection, fields (JSON), token (unique), password_hash (scrypt), expires_at, rate_limit_per_hour, is_active, success_message, created_by FK |
| `nivaro_submissions` | uuid PK, form FK → submission_forms, data (JSON), ip, created_at |
| `nivaro_field_watches` | increments PK, name, collection, field, created_by FK |
| `nivaro_field_watch_subscribers` | increments PK, watch FK, user FK, is_active |
| `nivaro_notification_subscriptions` | increments PK, user FK, collection, event_type, filter_field, filter_value, label, is_active |
| `nivaro_import_jobs` | uuid PK, collection, file_name, csv_data (JSON), column_map (JSON), duplicate_strategy, id_field, status, progress counters, errors (JSON), created_by FK |
| `nivaro_sla_rules` | increments PK, workflow_template FK, state_key, name, duration_hours, warning_threshold_pct, business_hours_only bit, notify_on_warning bit, notify_on_breach bit, escalation_user FK, is_active |
| `nivaro_alert_definitions` | increments PK, name, category, collection, field, operator, threshold, unit, filters (JSON), cooldown_minutes, is_active, created_by FK |
| `nivaro_alert_subscriptions` | increments PK, alert_definition FK, user FK, notify_email bit, notify_inapp bit; UNIQUE(alert_definition, user) |
| `nivaro_alert_log` | increments PK, alert_definition FK, collection, item, field_value, triggered_at |
| `nivaro_tree_configs` | Per-collection tree config; parent_field, label_field, order_field, maintain_path bit (materialized path/depth columns on the collection) |
| `nivaro_tree_permissions` | Subtree role grants; collection, node_id (varchar), role FK, action (read/update/delete/*), allow bit; rule covers node + descendants |
| `nivaro_at_risk_rules` | Per-collection risk highlight rules; collection, name, conditions (JSON `[{field,op,value}]`, values may use `{{field}}` refs), highlight_color (red/amber), is_active, created_by FK |
| `nivaro_hierarchy_configs` | Multi-collection hierarchy definitions; levels stored as JSON |
| `nivaro_attribute_definitions` | Dynamic EAV: per-collection custom field defs; collection, key (slug), label, type (text/number/boolean/date/select), options (JSON), required, sort, is_active; UNIQUE(collection, key) |
| `nivaro_attribute_values` | Dynamic EAV: per-item values; collection, item_id (varchar — UUID or int PK), attribute_key, value (nvarchar(max), all types as text); UNIQUE(collection, item_id, attribute_key) |
| `nivaro_external_api_schemas` | OpenAPI/Swagger spec import log; external_api FK, title, spec_version, raw_spec (nvarchar max), endpoint_count, imported_at, imported_by FK |
| `nivaro_field_rules` | Per-collection inline field defaults; trigger_field/trigger_op/trigger_value → target_field/target_type/target_value, sort, is_active |
| `nivaro_field_groups` | Field group/tab definitions per collection; key (slug), label, type (section/tab), icon, sort, is_collapsed bit |
| `nivaro_collection_layouts` | Named layouts per collection; `is_active` marks the one used by ItemEdit; UNIQUE(collection, name); tab_mode ('tabs'|'steps'), validate_before_next bit, summary_enabled bit, summary_show_all bit, ai_enabled bit (all DEFAULT 0), disable_comments bit, disable_tasks bit (DEFAULT 0), conditions NVARCHAR(MAX) nullable JSON `{"role_ids":[...]}` — conditional layout by role |
| `nivaro_layout_field_assignments` | Per-layout field→group assignment + sort; UNIQUE(layout_id, field); overrides `group_key` on `nivaro_fields` for layout-enabled collections; label_override NVARCHAR(255) nullable, is_visible bit DEFAULT 1, default_expanded bit DEFAULT 1 — used by page slot sentinels (`__pipeline__`, `__comments__`, `__tasks__`) |
| `nivaro_scheduled_changes` | Future field/workflow/publish changes; uuid PK, collection, item_id, scheduled_at, change_type (field_update/workflow_transition/publish/unpublish), payload (JSON), status (pending/executed/failed/cancelled), error_message, created_by FK |
| `nivaro_record_templates` | Named pre-fill templates per collection; uuid PK, name, data (JSON), is_shared bit, role_id FK nullable, created_by FK |
| `nivaro_field_translations` | Per-field locale values; increments PK, collection, item_id (varchar), field, locale, value (nvarchar(max)); UNIQUE(collection, item_id, field, locale) |
| `nivaro_sub_rows` | Ordered sub-record rows; increments PK, parent_collection, parent_id (varchar), sub_row_field, sort, data (JSON) |
| `nivaro_sub_row_templates` | Saved sub-row sets per collection+field; uuid PK, collection, field, name, items (JSON), created_by FK |
| `nivaro_addendums` | Amendment records; uuid PK, parent_collection, parent_id (varchar), title, description, cost_impact decimal, timeline_impact_days int, status (draft/submitted/approved/rejected), rejection_reason, created_by FK, approved_by FK |
| `nivaro_addendum_approvals` | Immutable approved-change log; increments PK, addendum_id FK → nivaro_addendums, title, cost_impact, timeline_impact_days, approved_at, approved_by FK |
| `nivaro_workspace_templates` | Workspace schema snapshots; name, snapshot (JSON); replayed into new workspaces ("From template") |
| `nivaro_api_keys` | Named API keys; name, key_hash (sha256 of `nvk_` token), scopes (JSON), expires_at, ip_allowlist (JSON), rate_limit, last_used_at |
| `nivaro_usage_counters` | Per-workspace usage counters (items/storage/API requests) backing `nivaro_workspaces.quotas`; 429 on exceed |
| `nivaro_webhook_deliveries` | Per-attempt webhook log; webhook FK, payload, response status/body, duration, attempt; retry + replay endpoints |
| `nivaro_persisted_queries` | GraphQL persisted queries; id/hash → query text; supports explicit `{id}` and APQ sha256 extension |
| `nivaro_flow_versions` | Flow definition snapshots on every save; restore from FlowEdit Versions panel |
| `nivaro_pdf_templates` | Liquid PDF templates; name, collection, body, page setup; rendered via POST /api/pdf-templates/:id/render |
| `nivaro_erp_submissions` | ERP push tracking; collection, item, target, status (submitted/pending/accepted/rejected), payload, response; retry support |
| `nivaro_sync_jobs` | Bi-directional sync jobs; direction (pull/push), external_api FK, field mapping (JSON), conflict strategy (newest-wins/source-wins/manual), cron schedule, run stats |
| `nivaro_tasks` | Per-record task assignments; collection, item, title, assignee FK, due_at, status, completed_by/at |
| `nivaro_approval_chains` / `nivaro_approval_steps` | Sequential approval definitions; chain (name, collection) + ordered steps (approver user or role) |
| `nivaro_approval_instances` / `nivaro_approval_decisions` | Per-record approval runtime (current step, status) + immutable approve/reject log with comments |
| `nivaro_item_locks` | Soft edit locks; collection, item, user, 5-min TTL refreshed by heartbeat; amber banner + read-only mode for others; per-collection on/off via item_locking_enabled on nivaro_collections |
| `nivaro_saved_views` | Saved collection browser states (filters/sort/columns); private, shared, or role-scoped; pills above filter bar |
| `nivaro_api_logs` | API request ring buffer (14-day retention); route, method, status, duration, user; feeds /api-analytics |
| `nivaro_issues` | Operational issue log; severity (info/warning/error/critical), status (open/acknowledged/resolved), source link |
| `nivaro_dq_rules` / `nivaro_dq_runs` | Data quality rules (not_null/regex/range/unique/formula) + run results with pass/fail counts and failing rows |
| `nivaro_pages` | Page builder pages; slug, layout (JSON widget grid: table/kpi/markdown/iframe/recent-activity); viewed at /p/:slug |
| `nivaro_embeddings` | Semantic search vectors per collection+item; provider = Voyage AI (VOYAGE_API_KEY) or local hash fallback |
| `nivaro_ai_collection_settings` | Per-collection AI feature config: validation rules (JSON, each soft warn or hard block), duplicate-detection toggle + similarity threshold |
| `nivaro_widget_feeds` | Embeddable widget feeds; collection, fields (JSON), filters (JSON), widget_type (list/form), token (unique), is_active |
| `nivaro_retention_policies` | Privacy/retention policy config: inactivity_threshold_months, action (redact/delete/suspend_only), redact_fields (JSON), redact_value_template, exclusion_emails/roles (JSON), cron_schedule, is_active, dry_run_mode, last_run stats |
| `nivaro_retention_runs` | Immutable run log: policy FK, started_at, finished_at, affected_count, dry_run bit, errors (JSON), affected_ids (JSON sample), triggered_by FK |

**New columns on existing tables:** `nivaro_users` — totp_secret, totp_enabled, is_redacted (bit, DEFAULT 0), redacted_at (datetime); `nivaro_fields` — is_encrypted (AES-256-GCM via ENCRYPTION_KEY); `nivaro_workspaces` — quotas (JSON); `nivaro_webhooks` — signing_secret (X-Nivaro-Signature sha256= HMAC header); `nivaro_files` — expires_at (hourly cron prune). Business tables may add an optional `workspace_id` column for row-level workspace isolation.

**Layout/field additions (migrations 081–087):** `nivaro_fields` — placeholder nvarchar(500) nullable; `nivaro_collection_layouts` — tab_mode, validate_before_next, summary_enabled, summary_show_all, ai_enabled, disable_comments, disable_tasks, conditions (JSON); `nivaro_layout_field_assignments` — label_override, is_visible, default_expanded.

**Column additions (final batch):** `nivaro_workflow_states` — stage_visibility (nvarchar(32), default 'always'; controls stage progress track visibility: always|hide_unless_active|hide); `nivaro_workflow_bindings` — auto_start (bit, default 0), auto_start_state (nvarchar(36), nullable — state to start in on item create); `nivaro_roles` — ui_permissions (JSON text, array of disabled route paths for admin UI access control). `nivaro_alert_definitions` — detection_type ('threshold'|'anomaly'), sensitivity (stddev multiplier); `nivaro_notification_subscriptions` — digest_frequency ('instant'|'daily'|'weekly'); `nivaro_users` — last_digest_at (digest watermark); `nivaro_policies` — row_filter (JSON RLS conditions); `nivaro_settings` — available_locales (JSON array of locale codes). `nivaro_field_groups` — layout_id (int nullable FK → nivaro_collection_layouts.id NO ACTION; unique constraint changed from (collection, key) to (collection, key, layout_id) for layout-scoped rows)

### Migration source

`api/src/db/index.ts` custom `migrationSource`: scans `.ts`/`.js` (not `.d.ts`), always reports `.ts` names. Dev (tsx) and Docker (compiled .js) both record same name in DB.

### MSSQL FK rules

1. Self-referential FKs → `NO ACTION` only
2. Multiple cascading FKs on same table → `NO ACTION` (error 1785; applies to workflow_transitions, workflow_history)
3. `ON DELETE SET NULL` requires nullable column (error 1761)
4. Adding NOT NULL to populated table → add nullable, backfill, then `.alter()` to NOT NULL separately

---

## Auth flow

1. Admin → `/login` → click "Continue with Microsoft" → `GET /api/auth/login`
2. Server generates PKCE + state, stores in session, redirects to Microsoft
3. Callback: exchange code, `findOrCreateFromOIDC()` syncs first/last name, sets `req.session.userId`, redirects to `ADMIN_URL`

`authenticate` middleware: Bearer (static_token) first, then session. `COOKIE_SECURE=false` required for plain HTTP — `true` silently drops cookie, breaks OIDC callback.

---

## Workspace isolation

`resolveWorkspace` middleware (`middleware/workspace.ts`) reads `x-workspace` header → falls back to `user.current_workspace` DB lookup → falls back to default workspace UUID. Registered as `preHandler` in `collections.ts` and `roles.ts`.

**Scope:** collections + roles are workspace-filtered (`WHERE workspace = ? OR workspace IS NULL`). Item data rows are NOT filtered — full row-level isolation requires `workspace_id` FK per business table (future migration path).

Admin UI: `WORKSPACE_KEY = 'nivaro_workspace'` in `api.ts`. Request interceptor reads `localStorage` and injects `x-workspace` header on every call. `auth.tsx` writes `current_workspace` to localStorage on login. Switching writes new ID to localStorage before `window.location.reload()`.

---

## Workflow Engine

Templates → States (key, label, color, is_initial, is_terminal, lock_record) → Transitions (from_state null=any, required_roles JSON, group_label) → Bindings (collection + optional state_field) → Instances (per-record: current_state) → History (immutable log).

Routes at `/api/workflows`: CRUD, states, transitions, bindings, instance (start/transition).

`WorkflowPanel`: renders null if unbound; "Start Workflow" if no instance; colored state badge + transition buttons (same group_label → DropdownMenu); inline confirm+comment form.

---

## Pipeline / Owner Matrix Engine

Extends workflow with multi-dimensional ownership. Dimensions (dotted field paths, is_row_axis, required) × States → Owner Groups (filters JSON, priority INT) → Users.

**Specificity:** `getCellResult()` matches groups by filter subset, sorts by filter count DESC then priority ASC. `isInherited=true` when optional dims active but winning group doesn't cover them.

Routes at `/api/pipelines`: CRUD, states (+skip criteria), bindings, dimensions, owner-groups, owner-group-users, instance-owners, export/import.

`filters` on owner groups = JSON text. Always `parseJson()` on read, `toJsonStr()` on write. Same for `required_roles` on workflow transitions.

---

## AI Features

Admin-only. Key resolution: `ANTHROPIC_API_KEY` env var → `nivaro_settings.anthropic_api_key` DB fallback. `getClient()` is async. When no key found → `503`. Key configurable in Settings → AI Features card (masked on GET/display, preserved if masked value re-POSTed).

Routes: `POST /api/ai/generate` (field value generation, claude-haiku-4-5, max_tokens 500), `POST /api/ai/summarize` (record summary).

---

## Release image

`Dockerfile.release`: admin SPA at `/` via @fastify/static; API at `/api/*`; Socket.io at `/socket.io/*`; `setNotFoundHandler` serves index.html for SPA routes, 404 JSON for `/api/*` misses. Production: `PUBLIC_URL` = `ADMIN_URL` = same host.

Docker Inngest: needs real 64-char hex `INNGEST_SIGNING_KEY` — use `INNGEST_SIGNING_KEY_DOCKER` to avoid `.env` `local` value leaking into compose.

---

## Extension system

```typescript
// api/extensions/<name>/index.ts (dev) or index.js (prod)
export default {
  id: 'my-extension',
  async register({ app, database, inngest, logger, hooks, cron, callExternalApi }) {
    app.register(async (f) => { f.get('/my-route', async () => ({ ok: true })) }, { prefix: '/api' })
    hooks.before('articles', 'create', async ({ payload }) => { })
    hooks.after('articles', 'update', async ({ item }) => { })
    cron.schedule('daily-report', '0 9 * * *', async () => { })
  }
}
```

`callExternalApi` in context — extensions never see raw credentials.

`flows` in context — `{ registerOperation, registerTrigger, emit }` — Register custom flow op types and triggers; `emit(type, payload)` fires all active flows using that trigger.

---

## Mail

`sendMail()` / `sendRawMail()` in `services/mail.ts`. No-op when no SMTP host configured. SMTP config resolved at call time: `nivaro_settings` columns first (`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_from`, `smtp_secure`), env vars as fallback. Configurable in Settings → Email (with provider presets + test send). Templates: `api/templates/mail/` as LiquidJS. Child templates must use `{% layout 'base' %}` + `{% block content %}` (NOT `{% render %}`). `sendSms(to, body)` in `services/sms.ts` — reads `sms_provider` / `sms_account_sid` / `sms_auth_token` / `sms_from` / `sms_region` from `nivaro_settings`. Configurable in Settings → SMS (Twilio, Amazon SNS, Vonage, Sinch, MessageBird). Both services no-op with console.warn when unconfigured.

---

## CI/CD

- `build_production`: push to main (skip if `@skip` in message) → builds Dockerfile.release, tags + pushes
- `publish_sdk`: tag `^@sdk-*` → publishes @nivaro/sdk to GitLab npm registry via `CI_JOB_TOKEN`
- **GitHub Actions**: use tag versions (`@v4`, `@v3`) — do not SHA-pin

```bash
pnpm sdk:release minor   # bumps, commits, tags @sdk-x.x.x, pushes → triggers publish_sdk
```

---

## Admin routes

| Path | Page |
|---|---|
| `/` | Dashboard |
| `/collections` | Collection registry |
| `/collections/:col` | Paginated browser + bulk actions |
| `/collections/:col/:id` | Item editor + WorkflowPanel + PipelinePanel + RevisionsPanel |
| `/users` / `/users/:id` | User management + static token + RevisionsPanel |
| `/roles` | Roles + policies |
| `/workflows/:id` | Template editor: states, transitions, bindings |
| `/pipelines/:id` | Template editor: states, bindings, dimensions (dnd-kit), Owner Matrix |
| `/flows/:id` | Flow editor |
| `/dashboards/:id` | Dashboard builder (drag widget grid) |
| `/external-apis/:id` | Auth type, headers, test panel; Endpoints tab includes "Import Spec" collapsible for bulk-creating templates from OpenAPI 3.x or Swagger 2.0 JSON |
| `/webhooks/:id` | Webhook editor |
| `/rules/:id` | Rule editor (condition + action builder) |
| `/custom-queries/:id` | SQL editor + params |
| `/activity/:id` | Entry detail + RevisionsPanel |
| `/schema-snapshot` | Point-in-time schema snapshots |
| `/graphql` | GraphiQL explorer |
| `/settings` | Singleton settings + AI key |
| `/workspaces` | Create/edit/delete/switch workspaces |
| `/docs` | Full API + GraphQL + SDK reference |
| `/submission-forms` | List + create submission forms |
| `/submission-forms/:id` | Edit form + view submissions |
| `/field-watches` | Manage field watches + subscriptions |
| `/notification-subscriptions` | Manage user notification subscriptions |
| `/imports` | Import job list; auto-refreshes for in-progress jobs |
| `/imports/new` | 4-step import wizard |
| `/imports/:id` | Job detail with live progress counters |
| `/sla-rules` | SLA rule list + create/edit |
| `/alerts` | Alert definitions list (tabbed by category) |
| `/alerts/new` / `/alerts/:id` | Create/edit alert definition |
| `/hierarchies` | Multi-collection hierarchy list + config editor |
| `/hierarchies/:id` | Hierarchy config selected |
| `/hierarchies/:id/tree` | Tree browser — click nodes to open items |
| `/record-templates` | RecordTemplates page — manage item pre-fill templates |
| `/scheduled-changes` | ScheduledChanges page — view/manage scheduled content changes |
| `/api-keys` | Named API keys: create (token shown once), scopes, expiry, IP allowlist, rate limit |
| `/notifications` | Notifications Center — paginated inbox + mark-all-read |
| `/sync-jobs` | Bi-directional sync jobs: list, run-now, last-run stats |
| `/pdf-templates` | Liquid PDF template editor + render test |
| `/sdk-playground` | In-browser SDK REPL against the live instance |
| `/dead-letters` | Dead letter queue: inspect, retry, discard failed deliveries/runs |
| `/pages-admin` | Page builder — page list |
| `/pages-admin/:id/edit` | Page builder — drag-and-drop widget editor |
| `/p/:slug` | Page builder — published page viewer |
| `/api-analytics` | API analytics: p50/p95 latency, error rate, request timeseries |
| `/health` | Health dashboard (db/redis/inngest/migrations/sockets) |
| `/data-quality` | Data quality rules + run results |
| `/privacy-retention` | Retention policy list + create/edit + dry-run preview + run history |
| `/issues` | Issue log — severity/status triage |
| `/collection-presets` | CollectionPresets page — install starter kit presets |
| `/virtual-collections` | VirtualCollections page — manage SQL-view-backed read-only collections |
| `/widgets` | Embeddable widget feed manager — tokens + embed snippets |
| `/persisted-queries` | GraphQL persisted query registry |
| `/tasks` | Task assignments across all collections — create/assign/complete/delete; "My Tasks" scope filter |
| `/approvals` | Approval chain management (master-detail: chain + steps editor) + active instances tab with approve/reject |
| `/at-risk` | Global at-risk rule overview — live at-risk counts per collection, rule toggle; rule creation stays in DataModel |
| `/erp-submissions` | ERP submission status list across collections + retry |
| `/collection-layouts` | Layout CRUD + activate + clone + assignments |

---

## Admin UI layout patterns

AppLayout outlet renders children as `animate-page-enter flex-1 min-h-0 overflow-auto flex flex-col`. Every page is a flex item in that column — use `flex flex-1 min-h-0 flex-col` as the outer wrapper.

### Master-detail (standard list pages)

```
<div className="flex flex-1 min-h-0 flex-col">
  <header className="shrink-0 border-b …">   {/* sticky page header */}
  <div className="flex flex-1 min-h-0 overflow-hidden">
    <aside className="w-[272px] shrink-0 border-r overflow-y-auto …">  {/* left list */}
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-background">  {/* right detail */}
```

Pages using this pattern: **Pipelines**, **Roles**, **DataModel**, **Workspaces**.

Right panel states: `NoXxxSelected` empty state → inline create form → detail view with meta grid + actions. No dialogs for create/edit — inline panels only. Delete: confirm pattern inline (not modal).

### Two-column editor (settings/trigger left, content right)

Left panel fixed width (`w-[360px]`), scrollable, white background. Right panel flex-1, scrollable, slate-50 background. Used by **FlowEdit**.

### Left-nav sidebar

Fixed-width nav (`w-[200px]`) with icon + label items; right content area scrollable. Active item: `bg-[#00ceff]/10`. Used by **Settings** (Project / Localization / Microsoft / AI tabs).

### Filter sidebar

Fixed-width filter panel (`w-[224px]`) left; right = stat strip + table. Draft filter pattern: local state for inputs, separate applied state that triggers query — Apply button commits, Reset clears both. Used by **Reports**.

### Compact table

Full-width `<table>` with `text-[12px]` rows. No cards. Used by **Extensions**.

### UI component conventions

- **Never use native `<select>` or `<datalist>`** — always use shadcn `Combobox` (`Popover` + `Command` + `CommandInput` + `CommandItem`) for all dropdowns and pickers. The one exception is within native HTML forms that cannot use React portals. The standard `FieldCombobox` pattern lives in `admin/src/pages/Hierarchies.tsx` as a reference implementation.
- **Never use `<input type="text" list="...">` datalist** — use Combobox instead for searchable inputs with suggestions.

### Meta grid

`gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border` wrapper + white/card cell backgrounds — creates 1px dividers without nested borders. Used in detail panels for key/value stats.

---

## Key architectural gotchas

- **dotenv in config.ts** — NOT `--env-file`; breaks tsx watch
- **`COOKIE_SECURE=false`** — Docker HTTP silently drops cookie if true → broken OIDC
- **Custom migrationSource** — always reports `.ts` names regardless of actual file extension
- **MSSQL FK** — use NO ACTION everywhere; multi-cascade paths rejected (error 1785)
- **MSSQL NOT NULL** — add nullable → backfill → alter; can't add NOT NULL to populated table in one step
- **MSSQL ORDER BY (SELECT NULL)** — required when OFFSET/FETCH present but no real sort
- **`pluginTimeout: 30000`** — prevents onReady timeout during ALTER TABLE migrations
- **JSON text columns** — `required_roles`, `filters`, `skip_criteria`, `ad_group_role_map` all stored as nvarchar; always `parseJson()` / `toJsonStr()`
- **`previousData` in HookContext** — captured before update/delete; enables delta without second DB read
- **`logActivity()` returns ID** — lets `writeRevision()` FK-link to activity row
- **Activity logged for system actions** — schema changes (`schema-collection-create/update/delete`, `schema-field-*`), SCIM provisioning (`scim-provision/update/deprovision`), schema snapshots, tree config CRUD and node moves/reorders/rebuilds, tree-permissions CRUD, AI calls (`ai-generate`, `ai-summarize`), item-lock acquire/release, notification-subscription CRUD, saved-view CRUD — check individual route files for exact action strings
- **WorkflowPanel returns null** — safe to render on every item edit; API returns `{ data: null }` when unbound
- **Pipeline `formatState()` must call `parseJson(s.skip_criteria)`** — raw string causes `initialCriteria?.conditions` to be undefined on reload
- **`RelationValuePicker` displayField** — `fieldRelations` stores `{ collection, displayField }`; displayField = last segment of dotted path
- **GraphQL auto-schema** — built at startup; `POST /api/graphql/rebuild` refreshes without restart
- **GraphQL subscriptions** — separate WS route `/api/graphql-ws`; auth via `connectionParams.authorization`
- **GraphQL filter wrappers** — M2M/O2M use `collectionName_field_m2m_filter` with `_some`/`_none`; guarded by `visible.some(c => c.collection === targetCollection)` to avoid empty InputObjectType
- **`relCache` cleared per request** — module-level Map in `services/items.ts`; prevents stale cross-request relation data
- **Socket.io auth** — client emits `auth` with `{ token }`; server joins `user:${userId}` room; emits `auth:ok`
- **Notification columns** — `recipient/subject/status/timestamp/sender/message/collection/item` (NOT user/title/read/created_at)
- **External API secrets masked** — `token`, `password`, `client_secret`, api_key value → `"••••••"` on GET; PATCH preserves if masked re-submitted
- **Spec import upsert = slug-based dedup** — `POST /:id/import-spec` skips any path+method whose slug already exists for the api; does NOT update existing endpoints; YAML not supported (JSON only)
- **`nivaro_external_api_schemas` raw_spec** — stores full spec as JSON string in `nvarchar(max)`; GET /schemas endpoint excludes raw_spec column to keep responses lean
- **AI key DB fallback** — `getClient()` async; reads `ANTHROPIC_API_KEY` env then `nivaro_settings.anthropic_api_key`; masked on settings GET
- **Workspace isolation = collections + roles only** — items not filtered; `resolveWorkspace` preHandler on collections + roles routes
- **Badge default variant** — `bg-nvr-cyan/10 text-nvr-navy` (light) / `dark:bg-nvr-cyan/15 dark:text-nvr-cyan` (dark); prevents dark-on-dark in activity panels
- **SDK `Command<T>` pattern** — `cms.request(command)`; `readStateOwners` / `readAllStateOwners` avoid N round-trips for pipeline ownership
- **LiquidJS** — `{% layout 'base' %}` not `{% render %}` for block inheritance in mail templates
- **Submission form passwords** — hashed with async scrypt (not SHA-256); stored as `salt_hex:hash_hex` in `nvarchar(500)`; use `timingSafeEqual` for comparison
- **Import route = requireAdmin** — not just `authenticate`; any `nivaro_*` collection blocked inside `processImportJob`
- **Field-watch + alert subscribe** — both require `can(req.user!, 'read', collection)` check before insert; admins bypass
- **Hook wiring pattern** — `registerXxxHooks()` called before `buildServer()`; `setApp(app)` called after; module-level `let _app` holds Fastify instance for Socket.io emit
- **Import progress** — Socket.io emits `import:progress` to `user:${userId}` room every 10 rows; job detail page subscribes on mount
- **SLA elapsed** — computed on-demand from `nivaro_workflow_history` timestamps; `businessHoursElapsed()` counts Mon–Fri 09:00–17:00 only
- **Alert cooldown** — checked via `MAX(triggered_at)` from `nivaro_alert_log`; skips fire if within cooldown window
- **Monitoring sidebar section** — `monitoringNav` array in `AppLayout.tsx`; icons: Globe (forms), Eye (watches), Bell (subscriptions), Upload (imports), Clock (SLA), AlertTriangle (alerts)
- **Tree recursive CTEs** — all use `OPTION (MAXRECURSION 100)`; MSSQL doesn't use `RECURSIVE` keyword. `moveNode()` calls `isDescendantOf()` before updating to prevent cycles.
- **Tree config = optional** — collection browser and item edit only activate tree features when `GET /api/tree-configs/by-collection/:col` returns non-null
- **Multi-collection hierarchy vs same-collection tree** — `nivaro_hierarchy_configs` (Hierarchies page) spans different collections per level via FK chain; `nivaro_tree_configs` (Data Model → Tree section) is for single-collection recursive parent_id trees. They are separate features.
- **Dynamic EAV attributes** — `nivaro_attribute_definitions` (per-collection key/type definitions) + `nivaro_attribute_values` (per-item string values); all values stored as nvarchar(max), parsed by type on render. Item edit shows attribute card only when definitions exist for collection. Definitions managed in Data Model → Table Editor "Attributes" tab (admin only); values PATCH ignores keys without an active definition. Deleting a definition cleans up its orphaned values.
- **Rollup computed fields** — `computed_type: 'rollup'` in `nivaro_fields`; `computed_formula` holds a JSON `RollupFormula` (`related_collection`, `fk_field`, `aggregate` sum/count/avg/min/max, `value_field`, optional `recursive`). Virtual (read-time only, never stored). `computeRollupValue()` in `services/items.ts` runs per-item in `applyReadComputedFields` (N+1 accepted). Non-recursive = single aggregate `WHERE fk_field = id`. Recursive (only when `related_collection === collection`) = MSSQL recursive CTE over all descendants with `OPTION (MAXRECURSION 100)`; identifiers bound via `??`. UI: TableEditor Computed Formula → Rollup (aggregate) radio → `RollupConfigEditor` comboboxes; recursive checkbox shows only when related collection === edited collection.
- **Field Rules** — per-collection inline field defaults (`applyFieldRules()` in `items.ts`) — different from `nivaro_rules` (global automation: webhooks/notifications via `evaluateRules()`). Field rules apply on save (in `createOne`/`updateOne`) AND in real time in ItemEdit via `POST /api/field-rules/evaluate`. `evaluate` is computed without saving and returns only changed fields as `{ updates }`. Editor UI lives in the Data Model right panel (`FieldRulesSection`, registered collections only). `trigger_op`: eq/neq/null/nnull/in/contains; `target_type`: set/clear. `trigger_value` for `in` is a comma-separated string parsed as a JSON array.
- **HierarchyLevel.parent_fk** — column on the CHILD collection pointing to the parent collection's id. Level 0 has parent_fk=null (root). Never confused with parent_id (that's same-collection tree).
- **Extension `flows` registry** — `registerOp/registerTrigger` called in `ext.register()`; `emitTrigger` does a lazy `import('../services/flow-executor.js')` to break the circular dep (registry ← executor ← registry)
- **`external-api` flow op** — `runExternalApi()` in flow-executor: predefined mode calls `callExternalApi(apiId, ...)`, custom mode calls `assertSafeUrl(url)` then `fetch` with 30s timeout; `$error` always generic string, never `String(err)`
- **SDK tree/hierarchy commands** — `readTreeConfig/Nodes/Nested/Ancestors/Descendants/Children/moveTreeNode` for same-collection trees; `listHierarchyConfigs/readHierarchyTree/readHierarchyNodes/readHierarchyNodeChildren/readHierarchyNodeAncestors/createHierarchyConfig/updateHierarchyConfig/deleteHierarchyConfig` for multi-collection hierarchies
- **@nivaro/react** — headless form package in `react/` workspace; `useNivaroForm(collection, options, client?)` is the primary API (schema fetch, 300ms debounced field-rules eval, client-side visibility/lock, create/PATCH submit); `<NivaroForm>` + 8 unstyled field components are optional wrappers; zero CSS shipped; peer deps React 18+; `fetchFormSchema` in `@nivaro/sdk` is the snake_case Option A counterpart (two separate APIs, do not conflate).
- **Pipeline auto-start** — `auto_start=1` on a `nivaro_workflow_bindings` row triggers `hooks/pipeline-autostart.ts` after every item create; uses `auto_start_state` if set, else first `is_initial` state by sort; non-blocking (item creation always succeeds).
- **Role UI permissions** — `ui_permissions` on `nivaro_roles` is JSON text (array of disabled route paths); parsed on GET; `PATCH /roles/:id/ui-permissions` updates it; admins bypass entirely; AppLayout filters nav and redirects blocked direct-URL access.
- **Pipeline delegation** — `resolveActiveDelegate()` / `applyDelegations()` in `pipeline-engine.ts` substitute a delegate for an owner when `is_out_of_office=true` AND `delegate_id` is set AND (`delegate_expires_at` is null OR in the future). Applied at the tail of `resolveStateOwners()` so both base + instance owners are covered, then re-deduped. Users self-serve via `POST /users/me/delegate` (no admin needed); `manager_id` is admin-only via `PATCH /users/:id`. Self-referential FKs (`manager_id`, `delegate_id`) are `NO ACTION` (MSSQL error 1785 on multi-cascade).
- **Hierarchy scope filter** — CollectionBrowser auto-detects when current collection is a non-root hierarchy level; shows parent selector above FilterBar; M2O filters via FK column, M2M resolves child IDs via `/hierarchy/:id/node/:col/:id/children`
- **Hierarchy item context** — ItemEdit shows "Hierarchy Membership" card for non-root hierarchy items; uses `useQueries` to fetch ancestors for each relevant hierarchy in parallel
- **Draft/Publish** — `draft_publish_enabled` on `nivaro_collections`; `_status` virtual column (draft/review/published) tracked in `nivaro_draft_publish_state` (not in the business table); clone sets `_status=draft`; virtual collections do not support draft/publish
- **Virtual collections** — `is_virtual=1` + `virtual_sql` on `nivaro_collections`; query wraps SQL as `SELECT TOP 100 * FROM (...) _v`; no physical table created; mutations return 405; validate-sql endpoint returns column names before save
- **Scheduled changes** — stored in `nivaro_scheduled_changes`; Inngest auto-execution at `scheduled_at`; manual execute via `POST /:id/execute`; PATCH blocked when status != pending
- **Field groups** — `group_key` on `nivaro_fields` is a slug reference to `nivaro_field_groups.key` (not a real FK); TableEditor Groups tab manages; ItemEdit renders collapsible sections or tabs; fields with no group_key float above grouped sections
- **Repeater schema** — stored as JSON in `nivaro_fields.repeater_schema`; `[{ key, label, type }]` columns; values stored as JSON array in the item's actual field column; sub-field types: string/number/boolean/date/select
- **Sub-rows** — stored in `nivaro_sub_rows` keyed by (parent_collection, parent_id, sub_row_field); PATCH bulk-replaces ALL rows for a parent+field combo — always send the full desired list
- **Addendums** — `nivaro_addendums` + `nivaro_addendum_approvals`; approve action creates immutable `nivaro_addendum_approvals` row; approvals accumulate net cost_impact and timeline_impact_days per parent record
- **Field translations** — `is_translatable` flag on field; values in `nivaro_field_translations`; UNIQUE(collection, item_id, field, locale); PATCH upserts per locale; items API returns `_translations` map when `?translate=true`
- **Validation rules** — enforced server-side in `createOne`/`updateOne`; evaluated after field rules and before insert/update; returns 400 `{ error, field, rule }` on first failure
- **Visibility/lock/dependency rules** — stored as JSON in `nivaro_fields`; evaluated client-side in ItemEdit AND server-side via `/api/field-config/:col/:field/evaluate-*` endpoints; server-side lock enforcement silently ignores locked field values in PATCH
- **`dependency_config` cascade_filters** — JSON array on `nivaro_fields.dependency_config`; each rule: `{ parent_field, filter_column, clear_on_parent_change }`. Evaluated client-side in ItemEdit: `RelationPicker` appends `?filter={filter_column: {_eq: parentValue}}` to options fetch; `handleFieldChange` cascade-clears dependents when parent changes. Multiple rules per field supported (AND logic — all active parents filter simultaneously). Config UI: TableEditor field settings ⚙ popover → Cascade Filters section (M2O only). No server-side evaluation — purely client-side at edit time.
- **Record templates** — `role_id = null` means available to all roles; `is_shared = false` means personal (user-scoped); `POST /:id/apply` returns merged data without saving
- **Collection presets** — install is idempotent by collection name per workspace; presets are code-defined bundles, not stored in DB; admin-only install
- **Field encryption** — `is_encrypted` on `nivaro_fields`; AES-256-GCM with `ENCRYPTION_KEY` env (32-byte); encrypt/decrypt is transparent inside the items service (hooks, REST, GraphQL all see plaintext); encrypted fields are NOT searchable/filterable; losing the key = data unrecoverable
- **Row-level workspace isolation** — optional `workspace_id` column per business table; rows with NULL value, or tables without the column, belong to the default workspace; creates are stamped with the request workspace
- **API keys** — `nvk_` prefixed tokens; only the sha256 hash is stored (plaintext shown once at creation); scopes/expiry/IP allowlist/per-key rate limit enforced in authenticate; SCIM routes accept ONLY keys with the `scim` scope
- **Persisted queries** — when a request carries an `{id}` or APQ sha256 hash, the stored query text is substituted before execution; a query string sent alongside a known hash is ignored except on first registration
- **`is_redacted` excludes users globally** — `listUsers()` in `services/users.ts` adds `WHERE is_redacted = 0` by default; all user pickers/comboboxes throughout the UI inherit this filter automatically since they call the same endpoint. To include redacted users (admin audit), pass `?include_redacted=true` (not yet implemented; add to query params if needed).
- **Retention cron registration** — active policies with a `cron_schedule` are registered in `server.ts` `onReady` via `CronManager.schedule()`; adding a new policy at runtime requires a server restart or a `POST /retention/:id/run` manual trigger.
- **Rate limiting fails open** — Redis fixed-window counter (`RATE_LIMIT_PER_MINUTE`, per-key override); if Redis is down requests pass through unthrottled rather than 429
- **Embeddings provider switch** — `nivaro_embeddings` vectors from Voyage AI vs the local hash fallback are incompatible; switching providers requires a full reindex (`POST /api/search/semantic/reindex`) or similarity results are garbage
- **Cross-trigger recursion guard** — `cross_collection` rule actions track chain depth; at depth 3 further cross-collection writes are skipped and logged instead of looping
- **Workflow split/join** — parallel branch state is stored in workflow history comments (no new branch table); auto-join fires when all branches reach a terminal state
- **Marketplace tarballs** — extension install uses a built-in ustar parser (no tar dependency, no shell-outs); download URL is SSRF-guarded; path traversal entries rejected; admin-only
- **Row-level security** — `nivaro_policies.row_filter` is JSON text — always `parseJson()` on read; `$CURRENT_USER` / `$CURRENT_ROLE` tokens are substituted with the requesting user/role id at evaluation time; applies to read/update/delete in the items service; admins bypass
- **AI validation 422** — hard-block rules are enforced in a before-create/update hook; the hook registry now RETHROWS before-hook errors that carry a `statusCode` (instead of swallowing them), so the API surfaces 422 with the violated rules
- **Digest watermark** — `nivaro_users.last_digest_at` is shared between the daily (08:00) and weekly (Monday 08:00) digest crons; whichever sends first advances it, so an event is never delivered twice across digests
- **widget.js root alias** — the embed script is served at both `/api/widget.js` and `/widget.js` (root alias); embeds reference the `/api/widget.js` form
- **Zapier actions go through the items service** — `/api/zapier/actions/*` call `createOne`/`updateOne`, so RBAC, row-level security, hooks, computed fields, and activity logging all apply; REST hooks are plain `nivaro_webhooks` rows
- **available_locales** — stored as JSON text in `nivaro_settings`; `parseJson()` on read; drives the locale list in field translation editors (Settings → Localization)
- **Tree path column is ID-based** — `maintain_path` writes `/rootId/.../selfId` (record IDs, never labels) into a real `path` column + `depth`; maintained on create/move (subtree recompute via `updateSubtreePaths()`); full rebuild via `POST /tree-configs/:id/rebuild-paths`; enables `WHERE path LIKE '/x/%'` subtree queries
- **Tree permissions are restriction-only** — never grant beyond `nivaro_policies`; deepest matching ancestor rule wins, action-specific beats `*`, ties resolve to deny; admins bypass; list reads are batch-filtered (denied rows dropped), single read/update/delete return 403; 60s TTL "rules exist" cache per collection — `clearTreePermissionCache()` on CRUD
- **Inherited field values are virtual** — `is_inheritable` fields resolve at read time from the nearest non-null ancestor (path column when maintained, else recursive CTE); rows that inherited carry an `_inherited: {field: ancestorId}` sidecar; runs before computed fields; nothing is written to the row
- **Transition condition_rules** — AND semantics over `[{field,op,value}]`; null/empty/malformed = unconditioned; available-transition listings filter by them AND the execute endpoint re-fetches the record and revalidates — stale client view → 409 "Transition conditions not met"
- **At-risk rule values support `{{field}}` refs** — `{{budget}} * 0.9` / `{{baseline}} + 10` (single ref + optional `*`/`+` numeric operand only); ALL conditions AND per rule, any rule match flags the row (first match wins for colour); evaluate capped at 500 ids, summary scans 1000 rows/collection; `nivaro_*` collections blocked
- **`pnpm docs:api` defaults to DB mode** — builds `www/openapi.json` straight from `nivaro_collections`/`nivaro_fields` via `api/src/scripts/generate-openapi.ts` (no server/token); `--url <instance> --token <admin>` switches to fetching live `/api/dev-tools/openapi.json`
- **Primary buttons are white-on-cyan** — default Button variant uses white text on nvr-cyan (was navy-on-cyan, failed contrast); keep new buttons consistent
- **Sidebar active nav rows are full-width** — active highlight spans the full row width in `AppLayout.tsx` for BOTH the icon rail category buttons and the panel nav items; don't reintroduce inset/pill-width highlights (no `px-*` on the nav container, no `rounded-*` on the row)
- **`group_key` on `nivaro_fields` is legacy fallback** — for collections with layouts, `nivaro_layout_field_assignments` takes precedence; `GET /field-config/:collection` overlays the active layout's assignments automatically
- **Layout tab = `LayoutsTab` wrapping `FieldGroupsTab`** — `FieldGroupsTab` accepts `layoutId` prop; writes field assignments to `PUT /collection-layouts/:id/assignments` instead of patching `group_key` on fields
- **`readActiveLayout` returns compound response** — `{ layout, groups, assignments }` in one call; use for SDK consumers that need the full layout structure
- **Layout tab UX** — left panel = static Unassigned palette (read-only, by type then alpha); right panel = named groups (dnd-kit sortable) + permanent Ungrouped drop zone at bottom; Add Group form renders between named groups and Ungrouped; save debounced 400ms via `useEffect` watching `localAssignments`/`localFieldOrder` with `hasLocalChangeRef` guard to skip server-data reloads
- **Layout tab auto-seed** — `LayoutsTab` auto-POSTs a "Default" layout when `GET /collection-layouts` returns empty; covers new collections and collections that had no groups at migration time
- **Relation form auto-create column** — M2O and M2A `many_field` pickers accept `allowNew` typing; selecting "✚ Create '[name]'" creates the DB column (`schemaApi.addColumn`) AND registers `nivaro_fields` metadata before calling `createRelation`; type pill (integer/uuid, default integer) appears inline when a new name is entered
- **Delete relation drops FK constraint** — `DELETE /data-model/relations/:id` finds and drops the MSSQL FK constraint via `sys.foreign_keys` using `QUOTENAME + sp_executesql` before removing the `nivaro_relations` row; non-fatal if no FK exists
- **Relation POST insert-then-select** — `POST /data-model/relations` uses insert-then-`SELECT TOP 1 ... ORDER BY id DESC` pattern (not `.returning()`) because MSSQL/tedious returns row-count not identity on bare insert
- **`picker_filter` is curation-not-security** — see below
- **Picker exclusions are per-record, not per-field** — `nivaro_picker_exclusions` marks individual records as excluded from all pickers; toggled from ItemEdit header button or CollectionBrowser bulk action; items route applies exclusions when `?picker=1` via `whereNotIn`; existing FK references are NOT affected
- **Cascade filters require a `nivaro_fields` row** — M2M alias fields must have a row in `nivaro_fields` for cascade config to persist (PATCH /field-config auto-creates the row on first save for known alias fields); `dependency_config.cascade_filters` has two new keys: `clear_on_parent_change` (clears child when parent changes) and `clear_on_unavailable` (fetches to verify current value still in filtered options); M2M parent cascade reads from staging context + committed junction cache; pre-filtering on existing items uses `useQueries` to load committed parent values
- **Spec import YAML support** — `POST /external-apis/:id/import-spec` accepts JSON string, YAML string, or pre-parsed object; YAML parsed via `js-yaml`; deduplicates endpoints by slug; saves raw spec to `nivaro_external_api_schemas`
- **`picker_filter` is curation-not-security** — JSON filter on `nivaro_collections`; applied only in M2O/M2M relation picker option fetches (merged with cascade filter via `_and`); NOT enforced server-side on save; NOT applied to collection browser, filter bars, or API/GraphQL list reads; existing FK references to excluded records load and display normally (the current-value fetch is by ID with no filter). Use `row_filter` RLS for actual access control. Config: DataModel → collection settings → "Relation Picker Filter". Prefer attribute-based filters (`{"is_disabled":{"_neq":true}}`) over hard-coded ID exclusions — IDs break on data migration.
- **Page slot sentinels** — `__pipeline__`, `__comments__`, `__tasks__` stored in `nivaro_layout_field_assignments` with `label_override`, `is_visible`, `default_expanded`, and `sort` (absolute position in unified `localGroupOrder`). `GET /field-config/:collection` returns them as virtual rows so `FieldGroupsTab` init effect can read them back on reload. Pipeline/Comments/Tasks panels in ItemEdit read sentinel data from `activeLayoutData.assignments`.
- **Layout slot sort scale** — group sorts in `reorderGroupsMut` use absolute position in `localGroupOrder` (which includes slot keys and `'__ungrouped__'`), not relative index within groups. ItemEdit `orderedSectionItems` uses `g.sort` (server-stored) not array index. Slots and groups share the same unified sort scale so ordering is consistent.
- **Conditional layouts** — `nivaro_collection_layouts.conditions` JSON `{"role_ids":[...]}` — `resolveLayout()` in collection-layouts.ts picks the most-specific conditional match for `req.user?.role`; admins (`req.isAdmin`) always get the default layout. UI in LayoutsTab settings panel.
- **`defaultExpanded` on panels** — PipelinePanel/CommentPanel/TaskPanel use a `useRef` guard + `useEffect` to sync from the `defaultExpanded` prop on its FIRST non-undefined value, because panels mount before `activeLayoutData` resolves. `useState(defaultExpanded ?? false)` alone doesn't work due to async layout load timing.
- **M2M values not in `draft`** — for SummaryPanel, M2M field values are NOT in `draft`; must be read from junction query cache + staging via `useQueries` on `['m2m-items', ...]`. Only scalar and M2O FK values are in `draft`.
- **Dev Redis persistence** — `dev:redis` script uses `docker run --rm -p 6379:6379 -v nivaro_redis_data:/data redis:7-alpine redis-server --appendonly yes`; named volume persists sessions across container restarts. Default SESSION_TTL is 7 days (604800).
- **Layout DnD groups/slots** — `localGroupOrder` in `FieldGroupsTab` is `(number | '__ungrouped__' | SlotKey)[]`; includes slot keys alongside numeric group IDs. Save effect deps array must include `localGroupOrder`. DnD uses `pointerWithin` → `closestCenter` fallback for group/slot drags + compact DragOverlay pill; original dragged item goes `opacity-0`.
