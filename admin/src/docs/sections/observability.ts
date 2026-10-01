import type { DocSection } from '../types.js'

export const obsApiAnalytics: DocSection = {
  id: 'api-analytics',
  label: 'API Analytics',
  content: [
    { type: 'h1', id: 'api-analytics', text: 'API Analytics' },
    {
      type: 'p',
      text: 'Every API request is sampled into `nivaro_api_logs`, a ring buffer retaining 14 days of traffic. The /api-analytics page visualises it: request volume timeseries, p50/p95 latency, error rate, and the slowest/most-hit endpoints.'
    },
    {
      type: 'ul',
      items: [
        'Filter by time range, route, method, status class, and user.',
        'p50/p95 are computed over the selected window; the error-rate card breaks down 4xx vs 5xx.',
        'The ring buffer self-prunes — no maintenance required and bounded storage.',
        'The Requests panel is the per-request list behind the aggregates: newest first, filter by path, method, status class or how the caller authenticated (session, token, API key, masquerade, anonymous); expand a row for the client IP, user agent and — on a 4xx/5xx — the first kilobyte of the response body the caller received.',
        'GraphQL by operation splits the one /graphql path by what each call ran: calls, p50/p95, error rate (HTTP errors and 200 answers carrying errors), average depth and selections, top callers, the slowest calls, and every @deprecated field still selected with who selects it.'
      ]
    },
    {
      type: 'h2',
      id: 'api-analytics-traces',
      text: 'Slow requests: round trips, N+1s, the real plan'
    },
    {
      type: 'p',
      text: "Requests slower than TRACE_SLOW_MS (default 1000) keep a waterfall of their phases. Each phase now also carries how many database round trips it made — at ~37ms per trip on a remote server, the count is the latency — and two flags the counter derives on its own: **N× same statement** when one statement shape ran five or more times inside a phase (an N+1), and **wide select** when a `select *` hit a table holding an nvarchar(max) column (the blob rides the wire whether or not anyone reads it). Below the waterfall the request's heaviest statement shapes are listed with their call counts."
    },
    {
      type: 'p',
      text: 'Every SELECT there has a **Plan** button. It reads the statement from the plan cache first — `sys.dm_exec_query_stats` for the exact parameterized text knex sent — so what you see is the plan the route really got, with its execution count, average, last and max elapsed time and logical reads. A hand-rewritten query with literal values gets a DIFFERENT plan (the 16.4s project-360 hub ran 133ms with literals and sent that investigation the wrong way twice). Only when the cached plan has been evicted does it fall back to an estimated plan over declared variables, and it says so.'
    },
    {
      type: 'note',
      text: 'The first run of this on a plain workflows list read found 67 round trips in one request, a 25× repeated nivaro_fields lookup inside the decrypt phase (a cache that filled after the concurrent misses — fixed the same day) and the user row loaded with its avatar blob on every authenticated call.'
    },
    { type: 'h2', id: 'config-read-cache', text: 'Configuration read cache' },
    {
      type: 'p',
      text: 'Saving one record reads the same configuration many times: relations, field lists, rules, layouts, column lists. Those reads are answered from a short-lived cache underneath the query layer, so every caller benefits without knowing about it. Only single plain SELECTs whose tables are all configuration tables are cached, never inside a transaction, never for records, users, policies or settings.'
    },
    {
      type: 'ul',
      items: [
        'A configuration change made through this instance clears the cache as it is written; the next read sees it.',
        'A change made by another process, another instance on the same database or a script is seen within about 5 seconds. Every configuration write moves one number in `nivaro_cache_epochs`; each process polls it and clears its in-process caches when it moved.',
        'Any schema change (ALTER, CREATE, DROP) clears it too, since column lists move.',
        '`GET /api/ops-db/metadata-cache` reports entries, hits, misses, reads that shared an in-flight statement, and how often a write cleared it.',
        '`METADATA_QUERY_CACHE=off` turns it off; `METADATA_QUERY_CACHE_TTL_MS` sets the lifetime. SQL Server only.'
      ]
    },
    { type: 'h2', id: 'cache-epoch', text: 'Caches across processes' },
    {
      type: 'ul',
      items: [
        'The write side needs no call: any statement that changes a configuration table counts, whoever runs it. A script that writes field or layout rows and exits is included; the number moves before its connection closes.',
        'Record writes never move the number.',
        'Ops Console, Caches lists every in-process cache. Clearing one there clears it in this process at once and in every other process within the poll.',
        '`GET /api/ops-runtime/caches` reports the number this process last saw, how many configuration writes it made, and the newest statement that counted, without its values.',
        "Caches derived from owner resolution (a person's working-on list, the inactive-people scan) clear in the process that wrote whenever a record changes state, a manual owner is added or removed, a delegate or out-of-office flag changes, or an owner group changes.",
        '`CACHE_EPOCH=off` turns the mechanism off; `CACHE_EPOCH_POLL_MS` sets the poll (default 5000). Self-hosted only.'
      ]
    },
    { type: 'h2', id: 'api-analytics-hooks', text: 'Hook timings' },
    {
      type: 'p',
      text: "Every hook runs inside a named span, `hook:<owner>:<collection>:<action>:<before|after>`, so a slow request's trace names the hook that cost the time. The owner is the extension id, or for core hooks the file that registered them. `GET /api/extensions/hooks/timings` lists every hook with runs, failures and its typical, slow and slowest time since the process started. The registry sheet of an extension shows the same per hook."
    },
    { type: 'h2', id: 'api-analytics-replay', text: 'Replaying a logged request' },
    {
      type: 'p',
      text: 'The request log keeps the query string of every call, up to 500 characters, with values under credential-looking names replaced by `••••••`. A replay sends the stored query with the stored body. A query that was cut short or that holds a masked value has to be completed first: the replay block shows it in an editable field, and `POST /api/api-analytics/requests/:id/replay` takes `query` beside `body`.'
    },
    {
      type: 'note',
      text: '`TRACE_TOP_SQL` sets how many statement shapes a slow-request trace keeps (default 8). `CRON_TICKS` decides whether scheduled jobs fire on the clock in a process. Unset, a development process (NODE_ENV=development) keeps every schedule registered but never ticks, because it usually shares its database with a deployed instance that already runs them; a production process ticks. `CRON_TICKS=on` makes a development process tick (your own database), `CRON_TICKS=off` stops a production-mode process ticking (a throwaway boot). Run-now and dry runs work either way.'
    },
    { type: 'h2', id: 'api-analytics-index-advisor', text: 'Index advisor' },
    {
      type: 'p',
      text: 'The advisor crosses the columns configuration already declares hot — M2O foreign keys, queue source filters, row-level security filters, workflow state mirrors — against the leading column of every index on tables past 50,000 rows, and ships each gap as a one-click CREATE INDEX. It also sweeps every table carrying both a `collection` and an `item` / `item_id` column for an index that LEADS on that pair (either order): that correlated "which instance / revision / state does this record have" lookup scanned 115k rows per check on nivaro_workflow_instances until migration 331 added the pair, and the same shape on nivaro_revisions and nivaro_activity was migration 321.'
    },
    { type: 'h2', id: 'api-analytics-inbound', text: 'Inbound integrations' },
    {
      type: 'p',
      text: 'Every request records how it authenticated, and a call that is not a browser session — a static-token user or a named API key — is by definition an integration. The Integrations page (Monitoring → Integrations → Inbound calls) rolls those callers up one card each: calls, errors, latency, last call, last error and top paths; picking a card scopes the request list to that caller. The Directus-era root aliases (`POST /files`, `POST /graphql`) that third-party integrations still use are logged like any `/api` route.'
    },
    { type: 'h2', id: 'api-analytics-dependencies', text: 'Partner dependencies' },
    {
      type: 'p',
      text: 'Picking a caller card also opens its Dependencies panel: every collection and field the caller read or wrote, the GraphQL operations and REST endpoints it called, with call counts and when each was last used. The map is built from the request log itself — a read’s fields come from its logged query string (`fields`, `sort`, `filter`, aggregate parameters), a write’s from its stored body, a GraphQL call’s from its document walked against the live schema (selections, `filter` / `sort` keys, the keys of a mutation’s `data`, documents sent by persisted-query id or hash included). It reaches back as far as the log does (14 days) and as deep as what was logged: bodies are stored only for token and API-key callers. A read with no field list is shown as “every field”. Two downloads narrow the published surfaces to exactly what the caller uses: an OpenAPI subset (the generated items spec, only its paths and fields) and a GraphQL SDL subset (the used types, fields, arguments and input fields).'
    },
    {
      type: 'p',
      text: 'The break check compares every partner’s used set — API keys, and static-token accounts marked as machine accounts — with the schema as it is now. A used collection or field that no longer exists, or a GraphQL root field the schema dropped, is a break; a used field carrying a deprecation stamp is a warning. The same findings feed the readiness scorecard (“Partner integrations still find the fields they use”, a warning, never a failure), the release preflight prints a one-line summary without blocking, and the field-removal confirm in the Table Editor lists the callers that used the field.'
    },
    {
      type: 'pre',
      code: `pnpm --filter @nivaro/api run partners:check            # exit 1 on a break
pnpm --filter @nivaro/api run partners:check -- --people # also people on tokens
pnpm --filter @nivaro/api run partners:check -- --json   # findings as JSON

GET /api/partner-dependencies?days=14                    // every caller, summarised
GET /api/partner-dependencies/check?days=14&people=1     // break + deprecation findings
GET /api/partner-dependencies/field/:collection/:field   // callers of one field
GET /api/partner-dependencies/:key                       // key = key:<id> | user:<uuid>
GET /api/partner-dependencies/:key/openapi.json?download=1
GET /api/partner-dependencies/:key/schema.graphql?download=1`
    }
  ]
}

export const obsHealthDashboard: DocSection = {
  id: 'health-dashboard',
  label: 'Health Dashboard',
  content: [
    { type: 'h1', id: 'health-dashboard', text: 'Health Dashboard' },
    {
      type: 'p',
      text: 'The /health admin page gives a live view of every subsystem, backed by a detailed health endpoint that goes beyond the public liveness probe.'
    },
    {
      type: 'pre',
      code: `GET /api/health/detailed
{
  "db":        { "ok": true, "latency_ms": 4 },
  "redis":     { "ok": true },
  "migrations":{ "ok": true, "pending": 0 },
  "sockets":   { "connected": 12 }
}`
    },
    { type: 'h2', id: 'health-startup', text: 'Startup' },
    {
      type: 'p',
      text: 'The page ends with how long this process took to start, phase by phase: migrations, building the server, routes, extensions, scheduled flows, event flows, listening, and the warms that run beside the boot. Each bar sits where the phase began and is as wide as it took. The newest 20 starts are kept per instance; a phase that took at least twice its usual time and a second longer is marked, and so is the whole start.'
    },
    {
      type: 'pre',
      code: `GET /api/ops-runtime/boot
{
  "instance": "production",
  "total_ms": 5120,
  "usual_total_ms": 4800,
  "slow": false,
  "slow_phases": [],
  "phases": [
    { "name": "Migrations", "ms": 1400, "at": 900, "background": false,
      "usual_ms": 1350, "slow": false }
  ]
}`
    },
    { type: 'h2', id: 'health-probes', text: 'Probes for proxies and deploys' },
    {
      type: 'p',
      text: 'Four public or admin endpoints answer four different questions. Point each consumer at the one that matches its question.'
    },
    {
      type: 'table',
      head: ['Endpoint', 'Question', 'Who calls it'],
      rows: [
        [
          'GET /api/version',
          'Is the process alive, and which build is it?',
          'Container health check, the redeploy notice'
        ],
        [
          'GET /api/ready',
          'May the proxy send this process traffic now?',
          'Proxy health check, the deploy gate'
        ],
        [
          'GET /api/preflight',
          'Did this deploy land coherently?',
          'Deploy gate, the Health page (admin)'
        ],
        [
          'POST /api/ops-runtime/smoke?strict=1',
          'Do reads, writes and extensions work end to end?',
          'Deploy gate (admin)'
        ]
      ]
    },
    {
      type: 'p',
      text: '/api/ready answers 200 only when the boot has finished, no migration in this build is pending, every extension named in REQUIRED_EXTENSIONS loaded, the database answers SELECT 1 within 2 seconds and Redis answers PING within 500 milliseconds. It is never “degraded”: a slow dependency fails the check rather than keeping the process in rotation. A process that received SIGTERM answers 503 at once, so the proxy stops routing to it while in-flight requests drain.'
    },
    {
      type: 'pre',
      code: `GET /api/ready  → 200 or 503
{
  "ready": true,
  "checks": [
    { "id": "boot", "ok": true, "summary": "Boot finished." },
    { "id": "migrations", "ok": true, "summary": "All 384 migrations applied; no files missing." },
    { "id": "extensions", "ok": true, "summary": "All 1 required extension(s) loaded." },
    { "id": "database", "ok": true, "ms": 80, "summary": "Database answered in 80ms." },
    { "id": "redis", "ok": true, "ms": 2, "summary": "Redis answered in 2ms." }
  ]
}`
    },
    {
      type: 'p',
      text: 'The smoke suite (database, Redis, migrations, collections read, required extensions, a request to the API itself) answers 200 with `ok` in the body by default, which is what the Ops Console button reads. Add `?strict=1` and it answers 503 when any check fails, so a deploy script can branch on the status code alone.'
    },
    { type: 'h2', id: 'health-scheduler-lease', text: 'Which process runs scheduled jobs' },
    {
      type: 'p',
      text: 'With more than one API process, only one fires scheduled jobs. Every process whose ticks are enabled (CRON_TICKS) competes for a lease in Redis; the holder renews it every 10 seconds and releases it on shutdown, so another process takes over within seconds. A process stops believing it holds the lease shortly before the lease could expire, so a Redis outage stops its ticks before anyone else could start. Each scheduled fire also takes its own lock, so one fire runs once even if two processes briefly overlap during a deploy. Run now works on any process and needs no lease. Boot catch-up runs only on the lease holder.'
    },
    {
      type: 'p',
      text: 'Background Jobs names the instance that holds the lease. GET /api/job-runs/registry and GET /api/ops-runtime/roster return it as `scheduler` ({ instance, is_leader, holder, ticks_enabled }). A process with ticks off never competes: run web replicas with CRON_TICKS=off and one worker with it on.'
    },
    {
      type: 'note',
      text: 'GET /api/health remains the lightweight unauthenticated liveness check; it reports latency as degraded, so do not use it for routing. The detailed endpoint requires authentication.'
    }
  ]
}

export const obsDataQuality: DocSection = {
  id: 'data-quality',
  label: 'Data Quality Inspector',
  content: [
    { type: 'h1', id: 'data-quality', text: 'Data Quality Inspector' },
    {
      type: 'p',
      text: 'Define data-quality rules per collection (`nivaro_dq_rules`) and run them on demand or on a schedule; each run (`nivaro_dq_runs`) records pass/fail counts and the offending rows. The /data-quality page shows rule health at a glance.'
    },
    { type: 'h3', text: 'Rule types' },
    {
      type: 'table',
      head: ['Type', 'Checks'],
      rows: [
        ['not_null', 'Field has a value on every row'],
        ['regex', 'Field matches a pattern'],
        ['range', 'Numeric/date field within min–max'],
        ['unique', 'No duplicate values in the field'],
        ['formula', 'Custom expression evaluates truthy per row']
      ]
    },
    {
      type: 'ul',
      items: [
        'Each run lists failing rows with links straight into the item editor.',
        'Failing rules can raise issues in the Issue Log automatically.'
      ]
    }
  ]
}

export const obsIssueLog: DocSection = {
  id: 'issue-log',
  label: 'Issue Log',
  content: [
    { type: 'h1', id: 'issue-log', text: 'Issue Log' },
    {
      type: 'p',
      text: 'A central log of operational problems — failed syncs, data-quality breaches, webhook dead letters, manual reports — stored in `nivaro_issues` with severity and status. Triage from the /issues page.'
    },
    {
      type: 'table',
      head: ['Field', 'Values'],
      rows: [
        ['severity', 'info | warning | error | critical'],
        ['status', 'open | acknowledged | resolved']
      ]
    },
    {
      type: 'ul',
      items: [
        'Issues link back to their source (sync job, DQ run, webhook, record) where applicable.',
        'Filter by severity, status, and source; resolve with an optional note.',
        'Subsystems raise issues automatically; users and extensions can create them via POST /api/issues.'
      ]
    }
  ]
}

export const obsTrafficMap: DocSection = {
  id: 'traffic-map',
  label: 'Traffic Map',
  content: [
    { type: 'h1', id: 'traffic-map', text: 'Traffic Map' },
    {
      type: 'p',
      text: 'The /traffic-map page (Monitoring → Operations, beside Realtime) is a live flow map of the API as this node sees it: callers on the left, API lanes in the middle (Items, Widgets, Pages, Custom queries, GraphQL, Inbound, Files, Extensions), data stores and partner APIs on the right. Edge width is requests per second; particles are individual requests coloured by kind; a node pulses on a write and flashes on an error. Admins only. Colours follow light and dark mode, and reduced motion turns the particles off.'
    },
    { type: 'h2', id: 'traffic-map-sources', text: 'Where the numbers come from' },
    {
      type: 'ul',
      items: [
        'Requests: the api-logger hook classifies every response into a lane and an entity (collection, widget id, page slug, query slug, GraphQL operation, inbound key, file route or extension) and counts it into a 15-minute per-second ring in memory. Route templates replace id-shaped and token-like segments with :id, so no access token ever appears.',
        'Internally dispatched requests are counted once: the root /graphql alias re-dispatches to /api/graphql, and the call is counted under its real GraphQL operation, not twice.',
        'Writes: broadcastCollectionUpdate reports create/update/delete with the record id and the names of the fields written — never values. One PATCH that writes a parent and twenty lines counts as twenty-one writes.',
        'Partner calls: every callExternalApi lands on its partner node and is attributed to the request that caused it.',
        'History (1h / 6h / 24h in the inspector) is rolled up from nivaro_api_logs, nivaro_outbound_log and open nivaro_issues. It reads the newest 20,000 log rows and says so when it truncates. Open issues are matched by route family (the template), not per entity. History for GraphQL calls made through the root /graphql alias may show as anonymous.'
      ]
    },
    {
      type: 'pre',
      code: `GET  /api/traffic-map/snapshot?window=60|300|900   → the rings for this node
GET  /api/traffic-map/catalog                      → labels for entities, callers, partners
GET  /api/traffic-map/entity/:lane/:entity?hours=  → rolled-up history + issues + slow traces
GET  /api/traffic-map/down/:id?hours=              → partner call history (ext:<api id>)
socket  admin:join {room: 'traffic-map'}  → one 'traffic-map:frame' per second while watched`
    },
    { type: 'h2', id: 'traffic-map-limits', text: 'Limits and scope' },
    {
      type: 'ul',
      items: [
        'Per node: the numbers are this API process only, and frames go only to watchers connected to this node.',
        'Cloud mode (CLOUD_META_DB_URL set): the emitter does not start and every /api/traffic-map route answers 404, because one process serves many tenants and the aggregator is per process. Cloud tenants do not get the page.',
        'A lane holds at most 40 entities (extras fold into "other …"), an entity keeps 20 keys, 200 events are buffered and at most 40 are sent per frame (events_dropped counts the rest). Idle rings are swept after 15 minutes.',
        "The caller filter uses the caller's own counts for totals; the hot table is approximate (entities whose top callers include that caller, or with a live event from it).",
        '/issues/:id opens the Issues page on that issue, pinned on top when it is older than the newest 200.'
      ]
    },
    {
      type: 'note',
      text: 'Frames are built only while someone has the page open; nothing is written to the database on the request path.'
    }
  ]
}
