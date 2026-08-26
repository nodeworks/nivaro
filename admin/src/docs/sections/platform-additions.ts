import type { DocSection } from '../types.js'

export const eventsAndFlags: DocSection = {
  id: 'events-and-flags',
  label: 'Events, Flags & Extensions',
  content: [
    { type: 'h1', id: 'events-and-flags', text: 'Events, Feature Flags & Extension Platform' },
    {
      type: 'p',
      text: 'A batch of platform primitives for integrating with and extending Nivaro: a server-sent event stream, feature flags, a durable extension event outbox, declared extension settings, and capability manifests.'
    },
    { type: 'h3', text: 'SSE event stream' },
    {
      type: 'pre',
      code: `GET /api/events/ticket            → { data: { ticket, expires_in: 60 } }   (authenticated)
GET /api/events/stream?ticket=…&collections=a,b   (text/event-stream)

event: collection.update
data: {"collection":"articles","item":"42","action":"update","changed_fields":["title"]}`
    },
    {
      type: 'p',
      text: 'The stream carries field NAMES, never values — a consumer fetches the changed row through /items, where permissions apply. EventSource cannot set headers, so header-less consumers mint a one-shot ticket first (60-second TTL, single use); Bearer/session auth works directly. Per-collection filtering drops unauthorized collections silently.'
    },
    { type: 'h3', text: 'Feature flags' },
    {
      type: 'p',
      text: 'Admin → Feature Flags registers flags with an on/off switch, per-role gating, and a stable percentage rollout (each user hashes into a fixed bucket, so a 20% rollout shows the same 20% of people every day). Clients read their effective set from `GET /api/feature-flags/mine`; the `useFeatureFlag(key)` hook (shared/react) resolves unknown flags and fetch failures to false, so a flag can gate new code with zero risk to the old path.'
    },
    { type: 'h3', text: 'Extension event outbox' },
    {
      type: 'p',
      text: 'Extensions get durable at-least-once eventing: `ctx.events.publish(type, payload)` lands a row in `nivaro_extension_events`; a per-minute sweep delivers to `ctx.events.on(type, handler)` registrations with exponential backoff (2^attempts minutes, cap 60), dead-lettering after 8 attempts. Admin → Extensions → Events lists rows with Retry / Discard.'
    },
    { type: 'h3', text: 'Extension settings & capabilities' },
    {
      type: 'p',
      text: 'An extension may declare `settings: [{key, label, type, default}]` (string / number / boolean / secret) — the Extensions page renders a form from the schema, secrets are masked, and `ctx.settings.get(key)` reads typed values with declared defaults. Extensions may also declare `capabilities`; the loader records which context surfaces the extension actually touched, and observed-but-undeclared capabilities show amber on the Extensions page.'
    }
  ]
}

export const recordToolkit: DocSection = {
  id: 'record-toolkit',
  label: 'Record Toolkit',
  content: [
    { type: 'h1', id: 'record-toolkit', text: 'Record Toolkit' },
    {
      type: 'p',
      text: 'Additions to how individual records are addressed, exported, explained, and repaired.'
    },
    {
      type: 'table',
      head: ['Feature', 'Where', 'Notes'],
      rows: [
        [
          'Record dossier (PDF)',
          'Dossier button on saved records',
          'One PDF: field values by layout section, workflow history, comments, tasks, recent activity. Opt-in per layout: Data Model → layout settings → "Dossier export (PDF)".'
        ],
        [
          'Referenced-by panel',
          'Record sidebar',
          'What points AT this record: per-relation counts + sample links, resolved through the reader’s own permissions (RLS and scopes bound the counts).'
        ],
        [
          'Pretty URLs',
          '/collections/:c/s/:value + /api/items/:c/by-slug/:value',
          'Both resolve through the collection\'s URL alias (Data Model → Settings → URL alias) — case-insensitive, multi-field, lowest-id on duplicates. The briefly-separate slug field folded into aliases; legacy slug configs still resolve with a one-click migrate.'
        ],
        [
          'Custom empty states',
          'Collection browser',
          'Per-collection title, message, and CTA shown when a collection has zero rows (a filtered miss keeps the normal "no records match" guidance).'
        ],
        [
          'Single-field revert',
          'Revisions panel',
          'Revert ONE field to any revision’s value without touching the rest of the record; goes through the normal update path so validation and history apply.'
        ],
        [
          'Value provenance',
          'Admin → Value Provenance',
          'Why a field holds its value: derivation (rollup / computed / rule / auto-id / transition writeback) + the change timeline with each write classified manual / import / integration / automation.'
        ],
        [
          'One-record promotion',
          'Content Promotion → Single record',
          'Export one record (optionally with child rows) as JSON, preview a field-level diff on the target instance, apply as create / update / upsert.'
        ],
        [
          'Trash filters + bulk restore',
          'Admin → Trash',
          'Search, per-collection and age filters, and multi-select restore (cap 100 per batch, per-row results).'
        ],
        [
          'Batch write endpoint',
          'POST /api/items/:c/batch',
          'create[] and update[] rows in one call, per-row results, full items-service semantics per row. Cap 100 rows.'
        ]
      ]
    }
  ]
}

export const reportingAdditions: DocSection = {
  id: 'reporting-additions',
  label: 'Reporting Additions',
  content: [
    { type: 'h1', id: 'reporting-additions', text: 'Reporting & Dashboard Additions' },
    { type: 'h3', text: 'Pivot table widget' },
    {
      type: 'p',
      text: 'Report Studio widget type `pivot`: two dimensions (rows × columns, date bucketing supported on either axis) × one metric (sum / count / avg). Sticky first column, row/column/grand totals, 40×40 cell cap with an honest truncation note.'
    },
    { type: 'h3', text: 'AI insights widget' },
    {
      type: 'p',
      text: 'Widget type `ai_insight` reads the report’s OTHER widgets’ resolved data and writes a short "what stands out" narrative. Cached per day per config so viewing never re-bills; a Refresh action regenerates. Without an AI key it renders an honest "AI is not configured" card.'
    },
    { type: 'h3', text: 'Dashboard filter bar & drill-through' },
    {
      type: 'p',
      text: 'Dashboards gained a global filter bar (saved on the dashboard row as `global_filters`; applied to every widget whose collection carries the field, report-studio entity-filter semantics) and click-to-drill: KPI numbers, chart segments, and table rows open a records modal resolved AS THE VIEWER, so the drill list may honestly show fewer rows than the aggregate counted.'
    },
    { type: 'h3', text: 'Report widgets on record layouts' },
    {
      type: 'p',
      text: 'A layout widget slot can embed any Report Studio widget (`report_widget` type: pick report + widget in the Table Editor slot settings). An optional entity-filter binding scopes the widget to the record being viewed — with a filter configured and no value resolved, the slot shows a waiting placeholder rather than unscoped data.'
    },
    { type: 'h3', text: 'Scratchpad charts' },
    {
      type: 'p',
      text: 'SQL Scratchpad result sets with at least one text and one numeric column offer a bar / line / donut toggle beside the table (first 100 points).'
    }
  ]
}

export const adminOpsAdditions: DocSection = {
  id: 'admin-ops-additions',
  label: 'Admin & Ops Additions',
  content: [
    { type: 'h1', id: 'admin-ops-additions', text: 'Admin & Ops Additions' },
    {
      type: 'table',
      head: ['Feature', 'Where', 'Notes'],
      rows: [
        [
          'Schema change sets',
          'Admin → Change Sets',
          'Batch schema edits (add/drop/rename columns, add collections) previewed with per-op impact BEFORE a typed APPLY; applies sequentially and reports exactly what landed.'
        ],
        [
          'AI schema editing',
          'POST /api/ai/schema',
          'Plain language → a proposed change-set operations array. The model only proposes — every apply is an explicit admin action through the change-set preview.'
        ],
        [
          'Blueprint publishing',
          'Admin → Blueprints',
          'Export schema bundles with a manifest (name, version, counts); installs show the manifest + a diff against the live instance first.'
        ],
        [
          'Policy templates & role compare',
          'Admin → Roles',
          'One-click grant sets (Read-only / Contributor / Manager — additive, never rewrites) and a side-by-side policy diff between any two roles.'
        ],
        [
          'Custom profile fields',
          'Settings → Profile fields + Profile page',
          'Admin-defined extra user fields (cost center, skills…) self-served by each user; stored in the generic attribute tables under nivaro_users.'
        ],
        [
          'Visual query builder',
          'Custom query editor → "Build visually"',
          'Pick a collection, filters (:param tokens supported), aggregates, grouping and sort — generates T-SQL into the editor; the SQL stays hand-editable.'
        ],
        [
          'User groups',
          'Admin → User Groups',
          'Named teams with @slug mentions in comments (group members are notified like individual mentions).'
        ],
        [
          'Multi-IdP sign-in',
          'Settings → Sign-in providers',
          'Additional OIDC providers beyond the primary; each renders its own login button. Secrets masked; the primary env-configured flow is untouched.'
        ],
        [
          'Storage drivers',
          'Settings → File storage',
          'Local disk (default), S3-compatible (incl. R2/minio via endpoint override), or Azure Blob. New uploads use the active driver; reads fall back to local disk so switching never 404s history.'
        ],
        [
          'Theme studio',
          'Settings → Appearance',
          'Corner-radius presets and font pairing applied live; accent color stays under Project.'
        ],
        [
          'Test data generator',
          'Data Model → Settings',
          'Seeded, name-aware fake rows (≤100) through the full items service; refuses non-empty collections unless explicitly allowed.'
        ],
        [
          'Type conversion wizard',
          'Data Model → column settings',
          'TRY_CAST dry-run (failure count + samples) → typed CONVERT confirm; refuses PKs, FK-constrained, computed and auto-id columns.'
        ],
        [
          'Geocoding backfill',
          'POST /api/geocode/backfill',
          'Resolve an address column into lat/lng for existing rows (500/run, Nominatim-paced, job-run tracked).'
        ],
        [
          'Public status page',
          '/api/status.json + /api/status/badge.svg',
          'Unauthenticated ok/degraded signal for uptime monitors.'
        ],
        [
          'Cron timeline & Redis browser',
          'Monitoring nav',
          'Visual cron overlap timeline; read-only Redis key browser with TTLs.'
        ],
        [
          'Notification channels & sounds',
          'Profile + subscriptions',
          'Per-subscription In-app / Email toggles (NULL = on, so existing rows are unchanged) and an optional notification sound (off / subtle / chime).'
        ],
        [
          'Login-page notices',
          'Broadcasts → "Login page" channel',
          'Window-scheduled announcements shown on the sign-in screen for everyone (audience filters cannot apply before login).'
        ]
      ]
    }
  ]
}
