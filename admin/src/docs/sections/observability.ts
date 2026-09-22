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
        'The Requests panel is the per-request list behind the aggregates: newest first, filter by path, method, status class or how the caller authenticated (session, token, API key, masquerade, anonymous); expand a row for the client IP, user agent and — on a 4xx/5xx — the first kilobyte of the response body the caller received.'
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
