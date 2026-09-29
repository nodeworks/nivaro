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
  "inngest":   { "ok": true },
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
    {
      type: 'note',
      text: 'GET /api/health remains the lightweight unauthenticated liveness check for load balancers; the detailed endpoint requires authentication.'
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
