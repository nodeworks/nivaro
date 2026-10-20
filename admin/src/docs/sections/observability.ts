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
        'Rows from development instances (laptops, probes sharing the database) are hidden by default and pruned after 3 hours; "Deployed instances" switches to every instance. See Deploys & Versions.',
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
    },
    { type: 'h2', id: 'api-analytics-widget-timing', text: 'Per-widget timing on dashboards' },
    {
      type: 'p',
      text: 'A host with a widget canvas (the EFP portal) reports, for every widget it shows, how long the widget took to get its data (first sign of life to nothing left loading) and how long the screen took to paint it (the next painted frame after that). Each report carries the widget’s catalog key and the viewer’s role id; nothing about the record or the person is sent beyond the signed-in user the real-user timings already carry. Reports ride the same beacon batch as page timings, once per widget per page view, never while the layout is being arranged, and never for a hidden tab.'
    },
    {
      type: 'ul',
      items: [
        'Stored in `nivaro_rum_events` with kind `widget` — no extra table. route is `widget:<catalog key>@<ROLE UUID>` (`@-` for a person with no role), ttfb_ms = data time, fcp_ms = paint time, duration_ms = both. The 14-day retention applies.',
        'Page and route p75s, the people lenses and support-ticket traffic ignore widget rows.',
        'Dashboard defaults shows “Slowest widgets for <role>” (p75, last 7 days): bars split data and paint, amber from 2 s, `n=` marks a thin sample.',
        'Client: `rumWidget({ key, roleId, fetchMs, paintMs })` from @nivaro/react (after `startRum`). A bearer-token host passes `getToken` to `startRum`, since a beacon cannot carry an Authorization header.'
      ]
    },
    {
      type: 'pre',
      code: `GET /api/rum/widgets?role=<role uuid>&days=7&limit=10   // admin; role optional (all roles)
// { data: [{ key, samples, fetch_p75, paint_p75, total_p75 }], days, role, total_events }`
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
      type: 'p',
      text: 'Jobs labelled unsafe to run twice (the digests, broadcasts, chat sends and report deliveries) take a cluster-wide “running” marker in Redis while they run. A second start anywhere, whether run now, a chained run, a boot catch-up or the clock, is refused while the marker is held; run now answers 409 with code JOB_RUNNING and names the holder. If Redis cannot be asked, the run is refused too. The marker is renewed while the job runs and expires five minutes after a process dies.'
    },
    {
      type: 'p',
      text: 'Heavy jobs take turns across every process through one Redis slot, so a run now on a web replica never runs beside the worker’s nightly heavy job. A heavy job waits for the slot (up to two hours, then runs with a warning); if Redis is down it runs at once. `scheduler.heavy_slot` names the job holding the slot.'
    },
    { type: 'h2', id: 'health-metrics', text: 'Metrics for Prometheus' },
    {
      type: 'p',
      text: 'GET /api/metrics returns the Prometheus text format for this process: version and instance, memory and CPU, event-loop delay since the previous scrape, request counts and a latency histogram by route pattern (/api/items/:collection, never a raw URL), the database pool (in use, waiting, ceiling, five-minute p95 wait) and whether the process holds the scheduler lease. A scraper reads it with `Authorization: Bearer <METRICS_TOKEN>`; without METRICS_TOKEN only signed-in administrators can. Scrapes are not written to the API request log.'
    },
    {
      type: 'pre',
      code: `# prometheus.yml
scrape_configs:
  - job_name: nivaro
    metrics_path: /api/metrics
    authorization: { credentials_file: /etc/prometheus/nivaro-metrics-token }
    static_configs: [{ targets: ['nivaro-web:3055', 'nivaro-worker:3055'] }]`
    },
    { type: 'h2', id: 'health-secret-files', text: 'Secrets from files' },
    {
      type: 'p',
      text: 'Any setting can come from a file instead of the environment. `X_FILE=/path` sets X from that file (set X or X_FILE, not both). Every file in /run/secrets whose name is an environment-variable name becomes that variable, which is where Docker Swarm mounts a secret under its target name; NIVARO_SECRETS_DIR moves the folder and `off` turns it off. A secret file replaces a value already in the environment and the log names the variable, never the value. One trailing newline is dropped. An unreadable file stops the process at boot.'
    },
    {
      type: 'p',
      text: 'GET /api/extensions also carries each extension’s `build`: the export’s own `build` value, or else the `.release-sha` file a deploy writes beside the extension. A deploy gate compares it with the release it mounted.'
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

export const obsRealtimePipeline: DocSection = {
  id: 'realtime-pipeline',
  label: 'Realtime Event Pipeline',
  content: [
    { type: 'h1', id: 'realtime-pipeline', text: 'Realtime Event Pipeline' },
    {
      type: 'p',
      text: 'When a record changes, open pages hear `collection:update` with the collection, the record id, the action and the NAMES of the fields written (never a value). This page covers how those events survive a sleeping laptop, a server that lost Redis for a moment, and writes that bypass the items service. Admin → Realtime → Event pipeline shows the counters and the delivery probe.'
    },
    { type: 'h2', id: 'realtime-pipeline-journal', text: 'Catching up after a long absence' },
    {
      type: 'p',
      text: 'Every event carries a sequence number. A client that reconnects sends the last one it saw and receives what it missed. The fast journal in Redis keeps 15 minutes (5,000 events); every event is also written to `nivaro_event_journal` and kept 24 hours, so a laptop back from a night asleep replays the changes instead of reloading every list. Past 24 hours, or more than 500 events for the pages it has open, the client reloads as before.'
    },
    { type: 'h2', id: 'realtime-pipeline-stream', text: 'Across servers' },
    {
      type: 'p',
      text: 'With several API servers, record-change events travel between them on a Redis stream (`nvr:ev:stream`), each server reading from its own position. A server that loses Redis briefly picks up where it stopped, so its users miss nothing. Other socket traffic (presence, chat, notifications) still uses the Socket.io adapter. `REALTIME_EVENT_STREAM=off` restores the adapter for record changes too.'
    },
    {
      type: 'note',
      text: 'During a rolling deploy from a build without the stream, users connected to an older server miss events from newer servers until that server is replaced; they then catch up from the journal on reconnect.'
    },
    { type: 'h2', id: 'realtime-pipeline-raw', text: 'Changes made outside the API' },
    {
      type: 'p',
      text: 'Batch edits, imports run by a procedure, stored-rollup recalculations and extensions that run SQL announce the records they changed, so open pages refresh. A stored procedure or an outside script reports its changes by writing to the inbox table `nivaro_raw_writes`; the API reads it every 5 seconds and broadcasts each change with `source: "raw"`.'
    },
    {
      type: 'pre',
      code: `-- From a stored procedure (SQL Server): comma list of ids, or NULL for "records in this collection changed"
EXEC nivaro_announce_writes @Collection = 'forecasts', @Ids = '101,102,103',
  @Action = 'update', @Fields = 'status,amount', @Source = 'procedure:reforecast'

-- Any database: insert rows directly (item NULL = collection-wide)
INSERT INTO nivaro_raw_writes (collection, item, action, changed_fields, source)
VALUES ('forecasts', '101', 'update', 'status', 'script:fix-lines')

// From an extension
await ctx.sql.announceWrites?.('forecasts', ids, { action: 'update', changed_fields: ['status'] })`
    },
    {
      type: 'ul',
      items: [
        'More than 100 records of one collection in one go become a single event with `item: "*"` and `bulk: <count>`: lists show the "new changes" pill and open records refetch quietly.',
        'Imports run by a procedure announce the collections listed in their "Recalculate rollups" setting.',
        'Only names and ids are broadcast. Pages read the new values through /items, where permissions apply.'
      ]
    },
    { type: 'h2', id: 'realtime-pipeline-probe', text: 'Delivery probe' },
    {
      type: 'p',
      text: 'A Realtime delivery monitor (Monitors → New → Realtime delivery) runs every 5 minutes: a test connection inside the server joins a private room, a probe event goes out through the normal path (journal, durable table, stream) and the monitor records how long it took to arrive. Slower than the limit (default 2,000 ms), never arriving, or arriving without being journaled fails the check and raises an issue. "Run probe now" on the Realtime console runs the same check; the last 50 results from every server are kept.'
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
      text: 'The /traffic-map page (Monitoring → Operations, beside Realtime) is a live flow map of the API: who is calling, what they reach, and where the work goes next. Callers sit on the left, API lanes in the middle, data stores and outside services on the right. Edge width is requests per second (or bytes, time or errors), moving dots are individual requests coloured by kind, a row pulses when it is written to and flashes red on an error. Admins only. Colours follow light and dark mode, and reduced motion turns the dots off.'
    },
    {
      type: 'p',
      text: 'This page covers reading the map. The next three pages cover finding the cause of a spike, acting from a node, and sharing, capacity and running it across several API processes.'
    },
    { type: 'h2', id: 'traffic-map-reading', text: 'Reading the map' },
    { type: 'h3', id: 'traffic-map-columns', text: 'The three columns' },
    {
      type: 'ul',
      items: [
        'Callers (left): people, API keys and integration accounts. Under them are sources, the work that has no request behind it: scheduled jobs, flows, the staged import worker and socket events. Each source pulses into the collections it writes and the services it calls.',
        'API lanes (middle): Collections, Widgets, Pages, Custom queries, GraphQL, Inbound, Files, Extensions, System and Sockets. Each row is one entity (a collection, widget, page, query, GraphQL operation, inbound key, file route, extension, system table or socket event) with its requests per second. System and Sockets are shown by default; the Show chips hide lanes.',
        'Data and partners (right): the database, the cache, file storage, partner APIs (dashed outline), notification channels (mail, SMS, push, Teams) and the AI provider. The database node shows connection-pool pressure, the cache node its commands per second and the key families it touched.'
      ]
    },
    { type: 'h3', id: 'traffic-map-marks', text: 'Edges, dots and badges' },
    {
      type: 'table',
      head: ['You see', 'It means'],
      rows: [
        [
          'A thicker edge',
          'More requests per second, by default. In the Flow header, Edges show switches what thickness means: Requests, Bytes (response bytes per second), Time (total time per second, how much waiting an edge holds) or Errors (failed requests per second; failed partner calls on downstream edges). The legend and the numbers on edges follow the choice. Thickness switches between square root, log and linear, and Rates on edges prints each edge’s figure.'
        ],
        [
          'A highlighted path',
          'The selected node’s traffic. Selecting a caller traces its whole path (caller → lane → entity → downstream) and fades everything else until you clear it.'
        ],
        [
          'A dashed amber edge',
          'Someone acting as someone else: a masquerade or a simulated API key. The inspector names both people.'
        ],
        ['A dashed red edge', 'A retry storm: one caller repeating the same failing request.'],
        [
          'A dashed violet edge with an r value',
          'An inferred link: two entities that keep rising together. Turn these on with Inferred links in the toolbar.'
        ],
        [
          'Coloured partner edges',
          'Why partner calls fail: transient, rate limited, auth, not found or validation.'
        ],
        [
          'A faint hairline edge',
          'Traffic that weighs nothing in the chosen measure, such as an edge with no errors while Edges show is on Errors. It keeps the map’s shape.'
        ],
        ['Moving dots', 'Requests, coloured by kind: read, create, update, delete, error.'],
        ['A ring pulse / a red flash', 'The row was written to / the row or lane had an error.'],
        ['A green arc on a row', 'Its cache hit ratio (custom queries and widgets).'],
        [
          'A dashed outline on a row',
          'Rehearsed writes (dry runs, sandbox keys, flow tests) that were thrown away. They are counted apart and never added to real write counts.'
        ],
        [
          'A pill on a row or node',
          'Something to look at: duplicate requests, an N+1 query pattern, write conflicts, pool pressure, a failing job.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'How to read the map (in the Flow header) opens a guide with all of the above. It opens by itself on your first visit.'
    },
    { type: 'h3', id: 'traffic-map-controls', text: 'Narrowing the view' },
    {
      type: 'ul',
      items: [
        'Show, Kinds, Caller and the 1m / 5m / 15m window filter the canvas, the summary strip, the live events and the Hot entities table together.',
        'Ask in words: type a sentence such as "only writes by integrations to forecasts in the last 5 minutes" and press Turn into filters. One small AI call picks from what the map already shows; every value is checked again before it is applied. A kind of caller ("integrations") becomes a removable caller-group chip. Needs an AI provider (Settings → AI Features).',
        'Zoom with + and − in the Flow header, or Ctrl and the scroll wheel. Zoomed out shows lanes only; zoomed in shows each entity’s busiest route and every caller’s own edges. Escape clears a traced path.',
        'Group callers by app collapses callers into the admin app, your other front ends, integrations, and cron & sources; select a group to expand it and select it again to fold it. Callers that send no app header are grouped by account kind.',
        'All nodes draws every caller, source, entity (up to the 40 a lane keeps) and downstream node instead of only the busiest in each column. A map that tall scrolls inside its box, and only the part in view is drawn.',
        'Pin an entity (the pin in the inspector or the star in Hot entities) to keep it on your watch list across reloads. Pinned only narrows the live events and Hot entities to your pins. Up to 40 pins.',
        'Workspace chips appear when more than one workspace has traffic. Picking one redraws every figure on the page for that workspace.',
        'The Conflicts lens (on by default) outlines entities whose writes collided: stale edits, repeated transitions, record locks.',
        'Avatars in the toolbar show which other admins are watching the map and what each has selected, which helps on an incident call.'
      ]
    },
    { type: 'h3', id: 'traffic-map-rewind', text: 'Rewinding' },
    {
      type: 'p',
      text: 'Pause turns the window into a timeline you can drag back through the last 15 minutes, so someone who arrives after a blip can still see it. Live returns to the present. With the 15-minute window selected there is nothing earlier to show; pick 1 or 5 minutes to rewind.'
    },
    { type: 'h2', id: 'traffic-map-baselines', text: 'Normal for this hour' },
    {
      type: 'p',
      text: 'The map learns what is normal for every node, caller, caller-to-node edge and partner at each hour of the week, from hourly roll-ups of the request log (deployed instances only). The normal for 14:00 on a Tuesday comes from the same weekday at 13:00, 14:00 and 15:00 over the last four weeks: the median, and a range two spreads either side. The request log keeps 14 days, so the third and fourth weeks build up as the hourly job (traffic-baselines-rollup) rolls hours up; roll-ups are kept in Redis for 29 days.'
    },
    {
      type: 'ul',
      items: [
        'Node colour: an entity dot turns amber when its errors or latency are two spreads above its own normal and red at four. Until a normal is learned the old rule applies (red over 5% errors). A request surge gets a "3.1× usual" pill; callers and partners get a pill when they fail more than usual.',
        'Sparkline band: the inspector draws the node’s normal range behind its live line, and its "Normal for this hour" section shows requests, errors and p95 against their usual range.',
        'Health score: every entity gets one figure from 0 to 100. Errors take up to 40 points (worse when above normal), latency against its normal up to 30, saturation (database pool, event loop) up to 20 and open findings such as N+1 or retry storms up to 20. Hover the score for the breakdown. Hot entities has a Health column and can be ordered by Least healthy or narrowed to nodes below 80.',
        'What changed: when a node’s errors or latency rise past normal, the inspector finds the minute the rise began and compares the 15 minutes before with the minutes since. Callers, routes, screens, response sizes and client builds are ranked by their share of the rise, with any deploy, restart or config write just before it. This API process’s traffic only.',
        'Busy hours: "Show when it is busy" in the inspector draws a weekday × hour heatmap of requests, errors or p95 over the last four weeks, in your time zone.',
        'Summary: the Summary button turns the page into a plain view for non-technical readers: requests, errors, the slowest area, partners down and people active over the last 15 minutes, each green, amber or red against its normal, with one sentence on anything not green. The address carries ?view=summary, so the link can be shared with other administrators.'
      ]
    },
    { type: 'h2', id: 'traffic-map-sources', text: 'Where the numbers come from' },
    {
      type: 'ul',
      items: [
        'Requests: every response is classified into a lane and an entity and counted into a 15-minute, per-second ring in memory. Route templates replace id-shaped and token-like segments with :id, so no record id or access token reaches the map.',
        'Requests that are re-dispatched internally are counted once: the root /graphql alias counts under the real GraphQL operation.',
        'Writes: each create, update and delete is counted with its record id and the names of the fields written, never the values. One PATCH that writes a parent and twenty lines counts as twenty-one writes.',
        'Partner calls, notification sends, AI calls, webhook deliveries and cache commands are counted where they are made and attributed to the request, job or flow that caused them.',
        'Screens: the admin app and other front ends send the screen a call came from (its route pattern, never ids), which front end it is, and one id per page load. The headers are untrusted and normalised again on the server.',
        'History (1h / 6h / 24h in the inspector) is read from the request log, the outbound call log and open issues. It reads the newest 20,000 log rows and says so when it stops there.'
      ]
    },
    { type: 'h2', id: 'traffic-map-limits', text: 'Limits' },
    {
      type: 'ul',
      items: [
        'A lane holds at most 40 entities (the rest fold into "other …"), an entity keeps 20 keys, 200 events are buffered and at most 40 are sent per frame. Idle rings are swept after 15 minutes.',
        'Frames are built only while someone has the page open (or a node is asked for them); nothing is written to the database on the request path.',
        'Big maps: from about 800 nodes and edges the map is drawn with WebGL (the footer says so); text, badges and plug-in layers stay on the regular canvas over it, and hover, click, keyboard and the tooltip work the same. A browser without WebGL keeps the regular canvas. From 300 nodes and edges the layout and edge routes are worked out in a background worker so frames never stall scrolling or hover. A link can force one renderer with `renderer=gl` or `renderer=2d`.',
        'Edge weights (bytes, time, errors) are counted per edge in per-minute buckets, at most 2,000 edges each way, like the map’s own counters.',
        'When more than one API process serves traffic, see "Several API processes" on the Share & Scale page.'
      ]
    }
  ]
}

export const obsTrafficMapInvestigate: DocSection = {
  id: 'traffic-map-investigate',
  label: 'Traffic Map: Investigate',
  content: [
    { type: 'h1', id: 'traffic-map-investigate', text: 'Traffic Map: Finding a Cause' },
    {
      type: 'p',
      text: 'Select any node and the inspector opens beside the map, at the canvas height, scrolling inside. What it shows depends on the kind of node. Start with the figures and the sparkline, then work down the panels below.'
    },
    {
      type: 'p',
      text: 'Sparklines carry markers for what changed: API restarts and deploys, configuration writes and maintenance windows. A jump that starts at a marker usually has its cause right there.'
    },
    { type: 'h2', id: 'traffic-map-who', text: 'Who is driving it' },
    {
      type: 'ul',
      items: [
        'Callers: pick one caller in the inspector header and the entity’s figures, sparkline and events narrow to that caller (exact counts, not an estimate).',
        'Screens: the screens the calls came from ("record page → 41 calls"). The fan-out tile on the summary strip flags screens whose single page load fires more calls than the limit (60 by default).',
        'Signed in by: the split between browser sessions, static tokens, API keys, masquerade and simulated keys. A lane suddenly driven by tokens stands out.',
        'Acting as someone: requests made while an admin masqueraded, named as "admin as person", so they never read as that person’s own traffic.',
        'By workspace: the entity’s requests per workspace, on instances with more than one.',
        'Moves with: entities that keep rising and falling with this one over the last 15 minutes, and which usually moves first.'
      ]
    },
    { type: 'h2', id: 'traffic-map-durations', text: 'Durations by route' },
    {
      type: 'ul',
      items: [
        'Durations by route in the inspector shows one route’s request durations over 1 hour to 7 days as a histogram. When the requests fall into two groups (a fast path and a slow one) it says so, with each group’s share and typical time, because a single p95 then describes only the slow group.',
        'Below it, What the slow requests have in common compares the slow requests (the route’s slowest tenth) with the rest by their query string: limits over 1,000, a filter on a field, a date range of more than a year, every field (*), a search. Each is ranked by how much of the slowness it explains. Masked values are never shown.'
      ]
    },
    { type: 'h2', id: 'traffic-map-why-slow', text: 'Why it is slow' },
    {
      type: 'table',
      head: ['Panel', 'What it tells you'],
      rows: [
        [
          'Request cost',
          'Average database round trips and SQL time per request, where the time goes (sign-in, metadata, SQL, hooks, building the answer), and how much row filters and user scopes add. A request that averages more round trips than the N+1 limit (40 by default) gets an N+1 badge on the map and its repeated statement is shown.'
        ],
        [
          'Slow requests',
          'The slow requests this process kept for the entity, slowest first, each with its heaviest statements and the Plan / explain button.'
        ],
        [
          'Hook cost on this collection',
          'Every before and after hook that runs for the collection, slowest first, with what registered it (an extension or a core file).'
        ],
        [
          'Filter and sort shapes',
          'Which filter paths, operators and sorts callers use on the collection (shapes only, never values). The index advisor on API Analytics uses the same evidence.'
        ],
        [
          'Write amplification',
          'For each direct write, the derived writes it caused: rollups, queue cache rows, integrity rows, revisions, activity.'
        ],
        [
          'Response size',
          'Median and p95 response size. Hot entities has the same column for finding fat responses.'
        ],
        ['Cache', 'Hit ratio and roughly how many milliseconds the cache saved.'],
        [
          'What users felt',
          'On a page: the browser’s p75 load and route-settle times beside what the API took.'
        ],
        [
          'Duplicate requests',
          'Identical reads from the same caller within half a second, listed as pairs.'
        ]
      ]
    },
    { type: 'h2', id: 'traffic-map-why-failing', text: 'Why it is failing' },
    {
      type: 'table',
      head: ['Panel', 'What it tells you'],
      rows: [
        [
          'Error groups',
          'Errors grouped by their normalised message; each server-error group links to its issue.'
        ],
        [
          'Rejected requests',
          'Refused sign-ins and permissions (401, 403, 429) per caller, with the reason code and the key’s configured scopes and rate limit.'
        ],
        ['Retry storm', 'The caller that keeps repeating the same failing request, and how often.'],
        [
          'Conflicts',
          'Stale-edit collisions, repeated transitions, idempotency waits and record locks.'
        ],
        [
          'Hot records right now',
          'The ten records being written or locked most, with write counts, lock queue and conflicts; each opens the record.'
        ],
        [
          'Fields that change most',
          'Which fields are written most on the collection, and by whom.'
        ],
        [
          'Fields this operation selects',
          'On a GraphQL node: the fields partners actually select. Unused fields are candidates for deprecation.'
        ]
      ]
    },
    { type: 'h2', id: 'traffic-map-sources-panels', text: 'Jobs, flows, partners and services' },
    {
      type: 'ul',
      items: [
        'A scheduled job or flow shows its schedule or triggers, its recent runs with duration and outcome, and what it calls into. The import worker shows the run in progress and its rows per second.',
        'A partner shows its calls in this window, why calls fail, a latency spread, and what it is owed: missing, overdue and failed messages and its newest failed pushes.',
        'Notification channels show sends, failures and test-mode redirects; the AI provider shows calls, tokens, cost, the models that answered and any fallbacks; a webhook shows deliveries and slow receivers.',
        'Rejected, unknown and first-seen clients on public routes (share pages, public forms, widget feeds) are listed in their own panel, with IP addresses masked.'
      ]
    },
    { type: 'h2', id: 'traffic-map-ai', text: 'Explain with AI' },
    {
      type: 'p',
      text: 'Explain (in the inspector) sends the node’s own window (rate, latency, errors, kinds, top routes and callers, recent errors and events) and returns two sentences plus where to look next. One call per click. Ask AI can answer the same kind of question in chat ("who hit forecasts hardest today?") through its traffic tool, for administrators only.'
    },
    { type: 'h2', id: 'traffic-map-stack', text: 'Investigating from an event' },
    {
      type: 'p',
      text: 'The inspector tells you what a node is doing; the investigation panel tells you what one thing did. It is a second panel, docked to the right, that opens a request, a record, a job run or anything else by its exact id (every live event carries its request id, chain id, page-load id, client tab and build, and the job or flow behind a background write), and every id inside it opens the next thing on top. You never leave the map.'
    },
    {
      type: 'ul',
      items: [
        'From the live events: click a row, or its Inspect action, and the most specific thing it names opens: its request, else the record it wrote, else its entity. The Request, Record, Path and Issue actions on a row open those levels directly; Run and Flow open the job or flow run behind a background write.',
        'From a node: Inspect in the inspector opens the selected entity, caller or data/partner node as the first level. Lanes have nothing to open.',
        'From a hover card: rest the pointer on any id in a panel (or focus it with the keyboard) and after a moment a card shows what the server knows about it, a title and a few lines, with Open. Clicking the id opens it straight away.',
        'From the search box in the toolbar: paste a request, chain, recording, trace or person id, an activity, job, issue, partner push or AI call number, an email address, a record id (CR26-80329, workflows/123) or a route path. Enter opens the first result as a new investigation; Show in the panel opens the result list as a level instead. Names and titles are not searched. An API key or token pasted here is refused and never sent.'
      ]
    },
    {
      type: 'ul',
      items: [
        'Breadcrumbs across the top are the path you took. The first and the last two always show; anything between folds into a "…" button. Click a crumb to go back to it.',
        'Back (or Esc, or [) returns one level; ] goes forward again. Esc at the first level closes the panel and returns focus to where it was.',
        'Pin (p) keeps the current level in a left column and opens the next ones beside it, so you can read a trace next to the request that made it. Split needs about 760 px; narrower, only the current level shows and the pin stays on.',
        'The whole stack is in the URL as ?inspect=request:…/trace:…@<time>, up to eight levels, so the browser’s back button, a reload and Copy view link all keep it. Send the link to a colleague and they open the same stack at the same moment.'
      ]
    },
    { type: 'h2', id: 'traffic-map-stack-kinds', text: 'What you can open' },
    {
      type: 'table',
      head: ['Level', 'What it shows and what you can do'],
      rows: [
        [
          'Request',
          'Method, path, query, status, time, caller, how it signed in, IP and user agent, the body (masked) and the error. A GraphQL request shows its operation and variables apart. The same caller’s other calls within 5 s either side. Replay (the same block as API Analytics; needs the stored body, which only token and API-key writes keep), Copy as curl, and Compare with… in the header.'
        ],
        [
          'Trace',
          'The request’s phases as a waterfall with the time nothing accounts for, its top SQL tagged N+1 (the same statement repeated) and wide (many columns selected), and Plan, which opens the execution plan inside the level (SELECT statements only). Trace arms the trace ring to keep the next call on this route, for up to 20 calls or 15 minutes, optionally only this caller, so you can trace a request that is not slow.'
        ],
        [
          'Statement',
          'One SQL shape from a trace’s top SQL: how often it ran and from cache, its plan, the routes that ran it (each opens the entity) and the index advisor’s advice for the tables it touches. Shapes live in each process’s memory.'
        ],
        [
          'Compare',
          'Two calls on the same route side by side (a fast one against a slow one): status and time, each phase, SQL shapes added, removed, slower and faster, and query parameters that differ. Compare with… lists the route’s recent calls, marking the traced ones and the same caller.'
        ],
        [
          'Capture',
          'A capture armed from Capture next… in the toolbar: the next requests matching a route, caller or entity (up to 50, for 1 to 15 minutes), filling in as they arrive, with Stop. Each opens with its full body and trace even when it was fast. See Capture the next N on the Act page.'
        ],
        [
          'Event path (chain)',
          'Everything one request, job or flow caused, as a tree: the writes, transitions, partner pushes, flows and mails that followed, and the request it replayed or was replayed as. Request, write, record, flow and partner push steps open; mail, notification and partner-call steps do not yet.'
        ],
        [
          'Recording',
          'The person’s session replay inside the level, started 5 s before the moment, with the same event rail under the scrubber and Console / Network list (here under the player) as on the Session replays page. With no recording covering it, the nearest error clip within two minutes, or Follow this person and Keep their next 50 traces. Recordings and clips are kept for 7 days.'
        ],
        [
          'Record',
          'A read-only view of the record and the writes to it around the anchor (the latest five when there are none in the window), each opening the write. Reads, comments and transitions are not listed. Open full page goes to the record.'
        ],
        [
          'Write',
          'One write: who, when, how they signed in, the key, IP and reason, the exact old → new change taken from the revision the activity row points to, and the chain and request that made it.'
        ],
        [
          'Issue',
          'An issue or error group: occurrences (a count, with first and last seen), status, severity, source, route, who raised it, the record, resolution notes, the stack, the redacted request context, a screenshot and Watch the moment it failed. Issue on a server-error row in the live events finds the issue by its error fingerprint.'
        ],
        [
          'AI call',
          'One call to the AI provider: the prompt as system and messages (tool calls and results inline), the tools offered by name, rounds, tokens in and out, cache reads and writes, cost, latency, stop reason, the model that answered and the response. Reached from the AI calls footer under a request. Kept 30 days.'
        ],
        [
          'Job run',
          'A scheduled job’s run: status (interrupted, still running, or failed silently), the process that held the lease, outcome, error and progress, the writes it made (through its chain), the flows and pushes that followed, and the job’s schedule and next run. There is no per-run log beyond outcome, error and progress.'
        ],
        [
          'Flow run',
          'Where the flow halted and its $error, input and output, the flow’s operations with the halted and failed ones marked, who or what started it, and Dry run with this payload, which re-runs the flow through the tester on the stored payload and shows each step. Live runs keep no step trace; only the dry run has one.'
        ],
        [
          'Partner push (submission)',
          'What was sent to a partner and what came back: status, endpoint, error class, attempts newest first, the matching outbound log rows, the obligation it satisfies and Resend (two clicks), which uses the existing retry route. Values under credential-like keys are masked.'
        ],
        [
          'Caller',
          'A person, API key or integration account: routes, status mix, p95 and error rate in the window, the key’s scopes, row scopes, rate limit, allowlist and expiry, refused credentials by reason, circuit breakers on it, recent requests, and Fields it depends on (collections and fields it reads and writes, fetched on demand). Follow and Watch recording for a person.'
        ],
        [
          'Entity',
          'A collection, widget, page, query or other row of the map: live figures, callers, error groups (each opens the issue), 1, 6 and 24-hour history with issues and slow traces, recent failed requests and recent writes, and the query or widget behind it.'
        ],
        [
          'Query / Widget',
          'A custom query: its SQL and parameters, cache hits and misses, freshness of its sources, the last slow plan, what uses it and recent failed runs. A widget: its definition, the query it is bound to and recent render errors.'
        ],
        [
          'Page',
          'A screen: calls and loads in the window against the fan-out limit, the busiest load with its routes and caller, who is on it (live presence for a fixed path; for a pattern such as /records/:id, the callers that requested it), recent page loads and the client builds open in tabs for that app.'
        ],
        [
          'Data / partner node',
          'The database, cache, storage, a partner API, a channel or the AI provider: live figures, the partner’s summary and health (no secrets), mock instances, history and recent submissions.'
        ],
        [
          'Page load',
          'Every call one screen load made, as a waterfall: the slowest, the ones called more than once and the errors, each opening its request, with the person’s name. Real-user timings beside it are the page’s 7-day 75th percentile, not this load’s own.'
        ],
        ['Search', 'The results of the search box as a level, each result an id you can open.'],
        [
          'Investigation (notebook)',
          'A saved investigation: its notes (saved as you type), the saved stack as links, what each level showed when it was saved, Restore this stack and Delete. See Save investigation on the Act page.'
        ]
      ]
    },
    { type: 'h2', id: 'traffic-map-stack-moving', text: 'Moving between things' },
    {
      type: 'ul',
      items: [
        'Related, at the foot of every level, groups what else happened around it: Same chain (everything this event caused), Same record (changes around this time), Same caller (around this time), Same error (earlier and later issues with the same fingerprint), Same statement shape (this request’s top SQL) and Same page load. Each group shows ten and says how many more; each item opens.',
        'A request, trace or AI call carries a Page load link to the screen load it belonged to, and from there to every other call that load made: "why was this screen slow for Beth".',
        'The clock in the panel header is the time anchor: the moment the investigation looks around (the first level’s time, or Now) and how wide (5 minutes by default; 1 minute to 1 hour). Every level’s related requests, writes and changes are read around it. Anchor at <time> moves it to the current level’s moment; Anchor at now brings it back.',
        'Rewind map to here pauses the map at the anchor, so the canvas shows the same second the panel does. The map holds the last 15 minutes; older moments cannot be rewound to.',
        'Keys: j and k move through the live events and Enter opens the selected one; in the panel, [ and ] go back and forward, p pins and Esc goes back (closes at the first level); / and ⌘K (Ctrl-K) jump to the search box while the map has focus. None of them fire while you type in a field. The ? button in the panel header lists them.'
      ]
    },
    { type: 'h2', id: 'traffic-map-stack-limits', text: 'Limits' },
    {
      type: 'ul',
      items: [
        'Traces live in each API process’s memory, 200 at a time (`TRACE_BUFFER`), and only requests slower than `TRACE_SLOW_MS` are kept unless something armed them: Trace on a trace level, Capture next…, or Keep their next 50 traces on a person. A trace kept by another process reads as not found; statement shapes, plans and captures are per process too.',
        'Requests come from the API log, kept 14 days, so a request older than that opens with its facts but no body. AI calls are kept 30 days. Recordings and error clips are kept 7 days, and only exist where session replay is switched on.',
        'Replay needs a stored body, which only token and API-key writes keep; a read can be run again from Copy as curl.',
        'In cloud mode the investigation routes read process-wide state and are not tenant-aware, so they answer 404 and every level reads as not found. The map and the inspector history still work there.',
        'Captured bodies and traces are held in memory only, with credential-like values masked, and dropped when the capture’s time runs out.',
        'Explain this sends the model only what the open levels already loaded; a level you never opened is sent as "not loaded".'
      ]
    }
  ]
}

export const obsTrafficMapAct: DocSection = {
  id: 'traffic-map-act',
  label: 'Traffic Map: Act',
  content: [
    { type: 'h1', id: 'traffic-map-act', text: 'Traffic Map: Acting from a Node' },
    {
      type: 'p',
      text: 'Everything that changes something asks for two clicks and writes an activity row, through the same routes the rest of the admin uses.'
    },
    { type: 'h2', id: 'traffic-map-links', text: 'Going to the source' },
    {
      type: 'ul',
      items: [
        'Request on a live event opens the logged request in the investigation panel, where you can read the body, replay it and open its trace (see Investigating from an event on the Investigate page).',
        'Record opens the record there too, with the writes around that moment. Path opens the event path: the request, the writes it made, the transitions, partner pushes and flows that followed, each of which opens in turn.',
        'A caller opens Inbound calls filtered to it; a person opens their profile. An entity opens where it is configured; a partner opens its external API.',
        'Runbook links appear on a node when an Environments component’s notes name one, or when an extension declares one.'
      ]
    },
    { type: 'h2', id: 'traffic-map-chat-card', text: 'Share a node to chat' },
    {
      type: 'p',
      text: 'Share to chat on an entity or node posts its live figure and a block-character sparkline to a channel you can see. The message rewrites itself about every 30 seconds, without a new notification. It freezes with its last values when you freeze it, when a node that had errors has had none for about three minutes, after two hours, or if the message is deleted. Up to 10 cards can be live at once; a server restart stops the refreshing and leaves the last values in place. Posting and freezing write an activity row.'
    },
    { type: 'h2', id: 'traffic-map-actions', text: 'Actions' },
    {
      type: 'table',
      head: ['Action', 'Where', 'What it does'],
      rows: [
        [
          'Retry / Send now',
          'Partner node',
          'Retry re-sends a failed push with its stored payload; Send now sends a missing message (only when remediation is switched on under Settings → Integrations).'
        ],
        [
          'Tell me when…',
          'Any entity',
          'Creates a `traffic` monitor prefilled with the entity, metric (errors or requests per minute, p95, error rate), threshold and window. You are notified when it starts failing, like any ops monitor. Each API process judges its own traffic. The alert can cover all the node’s traffic, one caller’s traffic into it, or its calls to one partner (an edge). While the form is open it replays the alert over the last two weeks of the request log and lists each time it would have fired, so you can set the threshold before saving. Partner edges cannot be replayed (the log does not say which route made a partner call).'
        ],
        [
          'Deploy now?',
          'The page header (also on the Release card under Environments)',
          'Compares the last 15 minutes of requests with the normal for this hour, and checks for heavy jobs, background jobs and imports running and open incidents. It says Deploy now, or Wait with the reason and the quietest hour ahead. Fixed rules, no AI call.'
        ],
        [
          'Caller controls',
          'Caller node',
          'For an API key: set its calls-per-minute limit or revoke it. For a person or integration account: suspend it.'
        ],
        [
          'Pause',
          'Job, flow or partner node',
          'Pauses a scheduled job, switches a flow off, or switches a partner’s external API to mock answers on this instance. Each switches back the same way.'
        ],
        [
          'Fire a probe',
          'Entity',
          'Sends one safe read at the entity as you, so it lights up end to end as a live smoke check.'
        ],
        [
          'Replay load (dev)',
          'Caller node',
          'Shows how many reads the caller made in the last hour and the command that replays a sample of them against a throwaway API (see Share & Scale).'
        ],
        [
          'Circuit breaker',
          'Entity or caller',
          'Refuses (503) or limits (429) one entity or caller for a set number of minutes, with a reason. Every API process honours it and it lifts on its own.'
        ]
      ]
    },
    { type: 'h2', id: 'traffic-map-breakers', text: 'Circuit breakers' },
    {
      type: 'ul',
      items: [
        'Use one during an incident to take pressure off a struggling collection or stop a runaway caller. Refused callers get the code `TRAFFIC_BREAKER_OPEN`.',
        'A breaker lasts 1 minute to 24 hours and needs a reason. You cannot break your own account.',
        'Sign-in, health, version, readiness and the Traffic Map itself are never broken, so you can always lift a breaker.',
        'Breakers live in the cache so every process sees them; if the cache is down, breakers are off rather than refusing traffic.',
        'While any breaker is open, an "N breakers open" button in the toolbar lists them and lifts them.'
      ]
    },
    { type: 'h2', id: 'traffic-map-inflight', text: 'In-flight requests' },
    {
      type: 'p',
      text: 'The In flight panel lists requests this process has not finished, oldest first, with their age, route, caller and the SQL they are running. Cancel kills the database session running that statement: give a reason, then confirm. Use it for a runaway read, not for a write you want to finish.'
    },
    { type: 'h2', id: 'traffic-map-stack-actions', text: 'Acting from a drill-down' },
    {
      type: 'p',
      text: 'The investigation panel’s header carries actions that work on the whole stack, not one level. The level-specific ones (Replay, Copy as curl, Trace, Compare with…, Dry run with this payload, Resend, Watch what they saw, Restore this stack) are listed under What you can open on the Investigate page.'
    },
    {
      type: 'table',
      head: ['Action', 'What it does'],
      rows: [
        [
          'Explain this',
          'Sends the open stack to the AI provider and returns what happened, the likely cause and where to look next, with [L1], [L2] citations that jump to the level they came from. It sends only what the levels already loaded, compacted to 24 KB with credential-like values masked, so open the trace or the event path first if you want them considered. Needs an AI provider (Settings → AI Features). Explain again asks once more; each call writes an activity row naming the kinds, never the text.'
        ],
        [
          'Share',
          'Create issue… makes an issue (title, severity) whose details are every level’s key facts as Markdown plus the ?inspect= link back to this view. Post to chat… posts the stack’s path, the current level’s key facts and the link to a chat room you pick. Request, trace and replay links are included only when those levels are on the stack.'
        ],
        [
          'Save investigation',
          'Saves the stack, what each level showed and your notes as an investigation (a notebook). Investigations in the toolbar lists the saved ones; each opens as a level where notes save as you type and Restore this stack reopens the levels. Saving writes an activity row that appears on the Ops Console incident timeline with the investigation’s title (the notes stay in the notebook). Delete needs two clicks.'
        ],
        [
          'Live tail',
          'On an entity, caller or request level: a strip inside the level that shows the live events matching that entity, that caller (or background source) or that route while the panel is open, up to 50, each opening its most specific level. Only events the process you are watching streams to the page are seen. It switches off when you move to another level.'
        ],
        [
          'Export',
          'Copy as Markdown or Download Markdown writes every level’s key facts, each with its own ?inspect= link, for a bug report or a ticket. Download HAR writes the request levels on the stack as a HAR 1.2 file for a browser or proxy tool; a stack with no request has nothing to export that way. Levels that were never loaded say so in the export.'
        ],
        [
          'Capture the next N',
          'Capture next… in the toolbar holds the next requests matching a route (GET /api/items/workflows/:id), a caller (k12, u<user id>) or an entity (items/workflows): up to 50 of them, for 1 to 15 minutes, with their full traces and request bodies even when they are fast. A capture level opens at once and fills in; Stop ends it early. Bodies are masked, held in memory only and dropped when the time runs out. Admins only, and every capture writes an activity row.'
        ]
      ]
    },
    { type: 'h2', id: 'traffic-map-blast-radius', text: 'Blast radius' },
    {
      type: 'p',
      text: 'On an endpoint or a partner node, Show what depends on this works out what would break if it failed, from the last 7 days of traffic: how many people used it, the screens they had open, the flows and scheduled jobs that called it or wrote its records, the partners calling it and the partners its records are pushed to. For a partner it lists the flows with a step calling it, who triggers its calls and the collections whose records go to it. It is read-only and is kept for 5 minutes.'
    },
    {
      type: 'note',
      text: 'The request log has no screen column, so a screen is the page each person last opened before the call (within 30 minutes). The panel shows how many calls could be matched that way.'
    },
    { type: 'h2', id: 'traffic-map-tell-affected', text: 'Telling the people affected' },
    {
      type: 'p',
      text: 'From the blast radius, Tell affected people… opens a short message, already written, that you edit before sending. It goes through Broadcasts to the people who used this node or one of its screens in the last hour (the server works the list out; you never send to yourself). It arrives in their inbox, and as a banner for 4 hours unless you untick it. Two clicks; it writes an activity row. More than 2,000 people: send it from Broadcasts instead.'
    },
    { type: 'h2', id: 'traffic-map-debug-window', text: 'Debugging a node for a while' },
    {
      type: 'p',
      text: 'On an endpoint, an API key or a person, the Debug window panel switches on debugging for 5, 15, 30 or 60 minutes: every request touching it logs at debug level (read them in the Ops Console log, filtered on debug) and keeps its full trace, however fast. The kept traces are listed in the panel and open like any trace. It ends on its own, or with Stop now. Start and end are written to the Ops Console incident timeline. Every server honours it; traces are kept by the server that served the request.'
    },
    { type: 'h2', id: 'traffic-map-temp-cache', text: 'A temporary cache on a hot collection' },
    {
      type: 'p',
      text: 'On a collection’s node, Temporary cache answers the same read by the same caller from server memory for a few seconds (10 s to 2 min) while you deal with a spike, for up to 15 minutes. The live hit rate shows in the panel and a cached pill marks the node. It covers list reads, single records, aggregates and distinct values of ordinary collections, never system tables.'
    },
    {
      type: 'ul',
      items: [
        'Never shared: an answer is kept for one caller (person, role, API key, workspace and View as all count) and given only to that caller. Signed-out requests are never cached.',
        'A write to the collection, or to a collection related to it, drops its answers at once on every server. A read that goes through relations is dropped by any write.',
        'Changes made outside the app (stored procedures, recalculated rollups) can show late by up to the seconds you chose.',
        'A caller sending Cache-Control: no-cache always gets a fresh answer. Responses carry x-nivaro-temp-cache: hit or miss.'
      ]
    }
  ]
}

export const obsTrafficMapPlatform: DocSection = {
  id: 'traffic-map-platform',
  label: 'Traffic Map: Share & Scale',
  content: [
    { type: 'h1', id: 'traffic-map-platform', text: 'Traffic Map: Sharing, Capacity and Scale' },
    { type: 'h2', id: 'traffic-map-sharing', text: 'Sharing and comparing' },
    {
      type: 'ul',
      items: [
        'Copy view link copies a link that opens exactly this view: filters, selection, lenses, workspace, zoom, what edges show, All nodes and the rewind position.',
        'Share freezes the current window into a stored snapshot that opens read-only from a link (/traffic-map?snapshot=…). Add a note and it also appears on the Ops Console incident timeline. Snapshots keep the labels the map showed, and you can scrub through the frozen window.',
        'Record keeps a rolling recording of the canvas in your browser. Download the last 30 seconds as a video, or attach it to a new issue. Nothing leaves the browser until you do.',
        'Image saves the whole flow map (not only the part scrolled into view) as a PNG or SVG for an incident write-up or a change request. The time window, the filters and view choices, the environment (project, host, API instance and environment name) and a legend are printed on it, in the colours of your current theme. It is made in your browser; nothing is uploaded. A very tall map is too big for a PNG; download the SVG instead.',
        'Compare shows two windows of this deployment side by side from the request log (morning against afternoon, this hour against the same hour last week), or this deployment against another API registered under Environments, fetched live with that component’s token.',
        'Daily summary adds a traffic section to your daily summary email: busiest callers, new callers, error hot spots and integrations that went quiet. It is off until you turn it on.',
        'A compact traffic card sits on the Command Center admin rail.',
        'Compare snapshots (a panel under the map) puts two stored snapshots side by side: requests a minute, error share and p95 for every node, and requests a minute for every edge (caller to node, node to what it calls). Windows of different lengths still compare because the figures are per minute. "A a week earlier" picks the snapshot closest to a week before the second one, for this Monday against last Monday.'
      ]
    },
    { type: 'h2', id: 'traffic-map-data', text: 'Map data, schedules and cost' },
    {
      type: 'p',
      text: 'Map data (in the map header) is one card for what the map keeps and what it costs. Peak and scheduled snapshots are kept for 30 days by default; shared snapshots and investigation notebooks are kept until deleted. Set a number of days for any of them and the oldest are removed automatically; each line shows how many are kept and roughly how much room they take. Recordings of the map are saved to your computer or attached to an issue, so the map keeps none.'
    },
    {
      type: 'ul',
      items: [
        'Snapshots taken by themselves: a snapshot a few minutes after each day’s busiest minute (on by default, replacing the earlier one the same day), and optionally one every 1 to 24 hours. They are marked as peak or scheduled, stay out of the Share list, and show up in Compare snapshots. Self-hosted instances only.',
        'Environment band: a coloured band across the top of the map names the environment (production, staging, development), taken from the Environments registry when this instance is listed there and from NIVARO_INSTANCE otherwise. Snapshots print the environment they were taken in, so two open maps are not confused.',
        'What this is: the top of the inspector says in a sentence what the selected node is. It comes from a collection’s note, a custom query’s, flow’s or partner’s description, a background job’s description or an extension’s declared node; the system nodes have a built-in line. Edit it to write your own; "Use the automatic text" brings the original back.',
        'Map cost: the strip tile and Map data show the map’s own CPU (recording requests and building frames), an estimate of its memory, bytes sent to browsers and over the Redis relay. Above the request rate you set (default 300 requests a second, `TRAFFIC_SAMPLE_ABOVE_RPS`; 0 never samples) the ticker shows 1 event in N and says so. Counts, errors and the canvas stay exact.',
        'Incident timeline: in Ops Console each event shows a small picture of the map from the nearest stored snapshot within the hour. Click it to open the full snapshot.'
      ]
    },
    { type: 'h2', id: 'traffic-map-capacity', text: 'Capacity and health' },
    {
      type: 'ul',
      items: [
        'Headroom: the current request rate against a ceiling, either the best sustained minute this instance has carried over the last week or a fixed value you set (`TRAFFIC_CAPACITY_RPS`), with connection-pool use beside it. It reads "at 30% of what it can carry".',
        'Projection: the next 15 minutes from the recent trend and how the same time of day usually moves, for example "past the pool limit in 8 minutes at this rate".',
        'What if…: beside the headroom figure, try more or less traffic (+50%), another replica or moving a scheduled job to another hour, and see the projected requests per replica, headroom, pool use and event-loop lag. The projection scales today’s cost per request; it is a guide, not a load test, and changes nothing.',
        'Event loop: event-loop delay and garbage-collection pauses beside the request rate. A slow node with fast SQL is CPU-bound.',
        'Realtime: event-journal lag and how many tabs watch each live view, linking to /realtime.',
        'Fan-out: the screens whose page loads fire the most calls.'
      ]
    },
    { type: 'h2', id: 'traffic-map-back-office', text: 'Back-office nodes and badges' },
    {
      type: 'ul',
      items: [
        'Memory after GC: the memory the API process still holds right after a major garbage collection, with a trend line beside the event loop. If it climbs steadily it turns amber and says how fast it grows and how long until the limit. It needs about five minutes of collections to judge.',
        'Storage: each file storage backend you use (local disk, S3, Azure Blob) is its own node, with the reads, writes, deletes and existence checks it served, the bytes moved, how long the backend took (not the request around it) and what failed. A missing file is counted as missing, not as a failure.',
        'Database server: the database node also shows what the server itself is short of, from its own views every 15 seconds while the map is open: CPU, disk and log waits, queries waiting for memory, and tempdb use. SQL Server only; if the login cannot read server state the panel says so.',
        'Work queues: the staged import queue, the extension event outbox, webhook retries and flow runs still going appear as nodes while something waits, with the number waiting, the age of the oldest, how fast the queue drains and whether the backlog is growing.',
        'Missed runs: a job node gets a "missed a run" badge when the cron miss detector found it did not run when expected; its panel shows the expected time and the last run. Instances that do not run scheduled jobs show none.',
        'Import size: the import worker node shows each run’s file size and rows, and says when a slower run was only a bigger file.',
        'Bulk actions: a running bulk action appears as a node with records per second, how many were refused and who started it. It goes away when the run finishes.',
        'Tuning: a collection or query node with a pending Database tuning proposal gets a "tuning idea" badge; its panel lists the proposals with the saving each promises and links to Database tuning. A statement shape lists the proposals for the tables it touches.'
      ]
    },
    { type: 'h2', id: 'traffic-map-history', text: 'History: time-lapse, jobs and search' },
    {
      type: 'p',
      text: 'The History panel under the map loads nothing until you pick a view.'
    },
    {
      type: 'ul',
      items: [
        'Time-lapse plays the last 24 hours or 7 days (30 days, 90 days and 13 months with the telemetry store, below) at 60× or faster. Deploys, restarts, configuration writes, maintenance windows and incidents are marked on the curve. Pause or click anywhere to open that moment: its busiest nodes (click one to inspect it), what changed near it, and, for the last few minutes, Rewind the map here.',
        'Under the request curve: people online (from the 5-minute socket samples, where scheduled jobs run) and people making requests, so more people can be told apart from more work per person.',
        'Jobs against peaks draws each scheduled job at its usual start and length over a typical day. A job in the peak gets the quietest start of the same length as a cron expression to copy, and what moving it would do to the pool.',
        'Search answers "when did this caller last call this route", "when did this error first appear" and "busiest hour for this node or partner", over the last day to month. Every field is optional and matched exactly; each answer opens its moment on the map.'
      ]
    },
    {
      type: 'p',
      text: 'Without minute history the time-lapse reads hourly (or 5-minute) groups from the request log, which keeps about 14 days and knows nodes but not callers or partners. Turn on minute history in the panel header to keep every minute per node and per edge (requests, errors, p50 and p95, bytes) for 30 days, or a retention you choose. Every API process counts its own minutes and the instance that runs scheduled jobs writes them once a minute; old minutes are deleted every hour. It is off by default and not available in cloud mode.'
    },
    { type: 'h3', id: 'traffic-map-history-store', text: 'Long history from the telemetry store' },
    {
      type: 'p',
      text: 'The request log keeps about 14 days. Where a telemetry stack runs beside the instance (VictoriaLogs behind vmauth), Nivaro can read older history from it. Each API process writes one structured line per logged request to its own output (route template, map node, caller key, status, duration, instance, request id, and the capped error text; never the query string, body, address or user agent), and the host collector ships those lines to the store. Nivaro only reads: every query is built on the server from typed fields, with a read-only token, and the browser never talks to the store.'
    },
    {
      type: 'ul',
      items: [
        'Time-lapse gains a 30 days range, read from the store in 6-hour steps (people making requests included), and 90 days (12-hour steps) and 13 months (3-day steps) read from request rollups (below).',
        'Search answers ranges past 14 days from the store and says so under the answer.',
        'The SLO window can be set up to 13 months: up to 30 days the per-day figures come from the store’s request lines, longer windows from the rollups (one bar per week); the burn rates (24 hours at most) always come from the request log.',
        'API Analytics offers 90 days and 13 months: totals, the chart (one bar per day) and top paths (grouped by route) come from the rollups; the panels further down keep reading the request log’s 14 days.',
        'When the store does not answer, each view falls back to the request log’s 14 days and says so.',
        '`GET /api/traffic-map/history/store` (administrators) reports whether the store is set up, reachable, and how far back it reaches.'
      ]
    },
    {
      type: 'table',
      head: ['Setting', 'What it does'],
      rows: [
        [
          '`TELEMETRY_ACCESS_LOG=on`',
          'Write one structured access line per logged request (off by default).'
        ],
        [
          '`TELEMETRY_STORE_URL`',
          'vmauth in front of VictoriaLogs, e.g. `http://efp_obs_vmauth:8427`.'
        ],
        [
          '`TELEMETRY_STORE_TOKEN`',
          'The read token (query paths only). `TELEMETRY_STORE_TOKEN_FILE` works too.'
        ],
        [
          '`TELEMETRY_STORE_ENV`',
          'The `env` label this instance’s lines carry, so staging and production never mix.'
        ],
        ['`TELEMETRY_STORE_TIMEOUT_MS`', 'Per-query timeout (default 20000).']
      ]
    },
    {
      type: 'note',
      text: 'Off in cloud mode: the store has no tenant labels.'
    },
    { type: 'h3', id: 'telemetry-rollups', text: 'Request rollups: 13 months' },
    {
      type: 'p',
      text: 'The stack’s alert evaluator turns the access lines into per-minute totals in the metrics store, which keeps 13 months: requests, errors and server errors, and how many requests finished under 25 ms, 50 ms, 100 ms … 30 s, per map node and instance and per route template, plus distinct signed-in people per hour. Nivaro sums those per step for the 90 day and 13 month views. Two figures are estimates: p95 is interpolated inside the latency band that crosses it, and people making requests is the busiest hour in each step. Steps before the rollups started read as empty. Same settings as above: nothing more to configure in Nivaro.'
    },
    {
      type: 'p',
      text: 'Each access line also carries the response size (`bytes`) and the kind of caller (`ck`: `key`, `oauth`, `token`, `user` or `anon`), and every partner call the map sees writes its own line (`nvr: "out"`: the partner node id, the map node it was made for, status, duration, failed or not; no names, paths or error text). From those the stack also keeps per-minute partner totals and hourly totals per caller and per caller kind.'
    },
    {
      type: 'ul',
      items: [
        'Time-lapse: once the rollups reach back to the start of a 24 hour, 7 day or 30 day window, it reads them instead of the minute history in the database: map nodes and partners from the per-minute totals, callers from the request lines (the busiest 40). Longer ranges take callers from the hourly per-caller totals. Before then (or with `source=minutes|log|store`) it reads what it read before.',
        'Minute history: with the stack set up, the History panel says traffic history is kept for 13 months there and offers to turn the database minute history off. It is never turned off for you; installs without the stack keep using it.',
        'Headroom: the ceiling becomes the busiest single minute in up to 13 months of rollups for this instance (when that beats the request log’s 7 days), shown as "Best minute: N req/min on date" with a line of each week’s busiest minute. TRAFFIC_CAPACITY_RPS still wins; the 15-minute projection is unchanged.'
      ]
    },
    { type: 'h3', id: 'telemetry-traces', text: 'Request traces out to the stack' },
    {
      type: 'p',
      text: 'The slow-request traces above live in each process’s memory. With `TRACE_EXPORT_URL` set, finished requests also go out as OpenTelemetry spans: every slow request (`TRACE_SLOW_MS`), every server error, everything someone asked to keep (Trace next call, follow a person), and a small sample of the rest. Each trace has the request span, its phases nested by time, and one span per SQL statement with the statement text only (never its values). The path is sent without its query string. The trace id is the request id without dashes, so the request log row, the `x-nivaro-request-id` header, the access line’s `tid` and the trace all match. Traces queue in memory and go out in batches; a failure is counted and dropped, never slowing a response.'
    },
    {
      type: 'table',
      head: ['Setting', 'What it does'],
      rows: [
        [
          '`TRACE_EXPORT_URL`',
          'OTLP/HTTP traces endpoint, e.g. `http://efp_obs_alloy:4318/v1/traces`.'
        ],
        ['`TRACE_EXPORT_TOKEN`', 'Bearer token the receiver expects.'],
        ['`TRACE_EXPORT_SAMPLE`', 'Share of other requests sent (default 0.02).'],
        [
          '`TRACE_EXPORT_ENV`',
          '`deployment.environment.name` on every span (defaults to `TELEMETRY_STORE_ENV`).'
        ],
        ['`TELEMETRY_GRAFANA_URL`', 'Where the Telemetry page’s Open Grafana button points.']
      ]
    },
    { type: 'h3', id: 'telemetry-page', text: 'The Telemetry page' },
    {
      type: 'p',
      text: 'Operations → Health → Telemetry (administrators) shows the monitoring stack from inside Nivaro: whether the history store answers, whether traces are going out, firing alerts and failing uptime checks at the top; what this process sent next to what actually arrived in the last hour; the settings this server runs with (tokens shown only as set or not set); and the stack’s own health read from its metrics store: firing alerts, uptime checks, collected sources, backups to the file share, and disk and share space. Each part is read on its own, so one failing part shows its error without blanking the rest. Silenced alerts still appear (silences only stop the email); manage them in Grafana. `GET /api/telemetry/status`; `/api/metrics` also reports access lines and trace export counts.'
    },
    { type: 'h3', id: 'telemetry-ai', text: 'Asking AI about the telemetry' },
    {
      type: 'p',
      text: 'The Telemetry page has an Ask box ("why was it slow between 14:00 and 14:30?", "which routes failed most today?") and a Slowest requests list with Explain on every row. The answer comes from read-only tools over the stack: the request log (weeks), request traces, metrics from a fixed list (including requests, server errors and p95 per day for 13 months, from the rollups), container logs and the stack’s status. Every tool takes typed fields and builds its own query, so nothing the model writes runs as query text, and the answer names what it checked and the traces it looked at (each with Explain and Open in Grafana). Explain on a trace reads it from the traces store once it has left the process’s memory. The same tools are offered to the assistant in admin-only operations chat channels. `POST /api/telemetry/ask` (administrators, a few questions a minute), `GET /api/telemetry/traces`.'
    },
    { type: 'h2', id: 'traffic-map-nodes', text: 'Several API processes' },
    {
      type: 'p',
      text: 'Each API process counts its own traffic. While anyone watches the map, every process publishes its frames through the cache and the page merges them, so the map shows the whole deployment. When more than one process is sending, a Nodes control appears: all nodes combined (the default) or one process. Snapshots can be taken of every node or one. When nobody watches, nothing is published. In-flight requests, slow requests and the event loop stay per process.'
    },
    {
      type: 'h2',
      id: 'traffic-map-realtime-nodes',
      text: 'Live connections, media, search and MCP'
    },
    {
      type: 'p',
      text: 'These nodes cover traffic that never shows up as an ordinary request. Their figures come from the API process you are connected to, and none of them is available in cloud mode.'
    },
    {
      type: 'ul',
      items: [
        'Sockets node: select the Sockets lane or the Browser sockets source. Adapter lag is the time from a record event being written on another replica to this one delivering it; the node gets a badge when the average passes `ADAPTER_LAG_WARN_MS` (500 ms) or doubles against the minutes before. Replica clocks that disagree show up as lag.',
        'Busiest rooms ranks socket rooms by members or by events per minute. Click a record, collection or watch room to see who is in it and its recent events. Rooms that name a person or a private conversation (user and chat rooms except General) are folded into one row per kind and show counts only.',
        'Connection problems lists failed and downgraded socket connections reported by the browsers, grouped by network (the /24 of the address), browser and app, so a corporate proxy or an extension that breaks live updates shows up as one row. It also lists the sockets on long-polling right now. Reports are kept in memory for 24 hours and each person can send six a minute.',
        'Streams: every open Server-Sent Events stream (GraphQL subscriptions, the record event feed, saved views, the admin change feed) and graphql-ws subscription is a source feeding the Sockets lane, with connections open now, events sent and bytes. Heartbeats count toward bytes, not events.',
        'Media node: help-video streams and session-replay uploads, with bandwidth (the size each response or upload declares), people active in the last minute and failures.',
        'Search node: omnisearch, cross-collection, meaning and settings search, and the search box of a collection list, with their database time and the slowest queries.',
        'MCP clients: calls through the MCP server appear as the AI assistants source, with the tools used, the API keys that signed in and recent errors. The MCP server sends `x-nivaro-app: mcp` and `x-nivaro-mcp-tool` on every call; update `@nivaro/mcp` to see tool names.'
      ]
    },
    { type: 'h2', id: 'traffic-map-cloud', text: 'Cloud mode' },
    {
      type: 'p',
      text: 'In cloud mode (one process serving many tenants) every tenant has its own counts, and an admin sees only their own tenant’s traffic. The map, the inspector history, snapshots, Compare windows and the node merge are tenant-scoped. The panels that read process-wide state (in-flight requests, slow traces, capacity, breakers, probes and similar) are not available there.'
    },
    { type: 'h2', id: 'traffic-map-replay', text: 'Load replay (development only)' },
    {
      type: 'p',
      text: 'Replays an evenly spaced sample of one caller’s logged reads against a throwaway API at a chosen speed, then prints status counts and latency. GET requests only, run as the token you pass (not as the caller). It refuses unless NODE_ENV is development and refuses any registered or shared host.'
    },
    {
      type: 'pre',
      code: `pnpm --filter @nivaro/api run traffic:replay -- \\
  --caller k12 | u<user uuid> --target http://localhost:3099 --token <bearer> \\
  [--hours 1] [--sample 200] [--multiplier 2] [--dry-run]`
    },
    { type: 'h2', id: 'traffic-map-extending', text: 'Extending the map' },
    {
      type: 'p',
      text: 'An extension can name the business systems behind its partner calls, so the map reads "→ deployment requests" instead of "→ external API 7". A partner call goes to the first declared node that matches it, else to the plain partner node.'
    },
    {
      type: 'pre',
      code: `ctx.integrations.registerTrafficNode({
  id: 'deployment-requests',          // unique within the extension
  label: 'Deployment requests',
  match: { api: 'Warehouse API', path: '/api/deploymentRequests', method: 'POST' }
  // or match: (call) => call.apiName === 'Warehouse API' && call.path?.startsWith('/orders')
})`
    },
    {
      type: 'p',
      text: 'A front end of your own can send the same headers the admin app sends, so its calls appear under their screens and page loads: `x-nivaro-app` (which front end), `x-nivaro-page` (the screen’s route pattern, never ids) and `x-nivaro-load` (one id per page load).'
    },
    { type: 'h3', id: 'traffic-map-ext-lenses', text: 'Lenses from an extension' },
    {
      type: 'p',
      text: 'An extension can add its own lens: a chip beside the other lenses that, while on, puts a pill on the nodes it names and adds a panel to their inspector. The map asks for the data every 15 seconds while the lens is on; `read` runs on the server and has 5 seconds to answer. Only text, counts, a tone and links to pages inside the app are shown, so no extension code runs in the admin.'
    },
    {
      type: 'pre',
      code: `ctx.traffic.registerLens({
  id: 'late-orders',                  // unique within the extension
  label: 'Late orders',
  description: 'Orders the warehouse has not confirmed',
  inspectorPanel: { title: 'Warehouse' },   // false = no panel; nodeBadge: false = no pills
  read: async ({ window }) => ({
    badges: [{ node: 'items/orders', text: '4 late', tone: 'warn' }],
    panels: [{ node: 'items/orders', rows: [
      { label: 'Late', value: 4, tone: 'warn', href: '/collections/orders?late=1' }
    ] }]
  })
})`
    },
    { type: 'h2', id: 'traffic-map-config', text: 'Settings' },
    {
      type: 'p',
      text: 'More → Detector settings switches each detector on or off and sets its thresholds: fan-out, N+1, duplicate requests, retry storms, near timeout and correlated spikes. The settings are saved for this environment (its instance key), so a laptop and staging sharing one database keep their own; every server of it picks a change up within a minute. Saving takes two clicks and writes an activity row. The environment variables below are the defaults the card starts from.'
    },
    {
      type: 'table',
      head: ['Setting', 'Default', 'What it changes'],
      rows: [
        [
          '`TRAFFIC_SAMPLE_ABOVE_RPS`',
          '300',
          'Requests per second above which the ticker shows 1 event in N. 0 never samples. The Map data card on the map overrides it.'
        ],
        [
          '`TRAFFIC_N_PLUS_ONE_TRIPS`',
          '40',
          'Average round trips per request before an entity gets the N+1 badge.'
        ],
        [
          '`TRAFFIC_FANOUT_LIMIT`',
          '60',
          'Calls in one page load before a screen is flagged for fan-out.'
        ],
        [
          '`TRAFFIC_PROXY_TIMEOUT_MS`',
          '60000',
          'The proxy read timeout the near-timeout detector judges whole requests against.'
        ],
        [
          '`TRAFFIC_CAPACITY_RPS`',
          'unset',
          'A fixed request-per-second ceiling for the headroom gauge. Unset = the best sustained minute from the request log.'
        ],
        [
          '`TRACE_SLOW_MS`',
          '1000',
          'Requests slower than this are kept for the Slow requests panel.'
        ]
      ]
    },
    {
      type: 'pre',
      code: `GET  /api/traffic-map/snapshot?window=60|300|900   → this node's counts
GET  /api/traffic-map/cluster-snapshot?window=     → every node merged (or ?node=)
GET  /api/traffic-map/catalog                      → labels for entities, callers, partners
GET  /api/traffic-map/entity/:lane/:entity?hours=  → history, issues and slow traces
GET  /api/traffic-map/entity-detail?key=           → every inspector panel's figures
POST /api/traffic-map/snapshots                    → freeze a shareable snapshot
GET  /api/traffic-map/snapshots?kind=manual|auto|all → stored snapshots
GET  /api/traffic-map/snapshots/compare?a=&b=      → two snapshots, node by node and edge by edge
GET  /api/traffic-map/snapshots/near?at=&at=       → the map at the moment of each timeline event
GET|PATCH /api/traffic-map/map-settings            → retention, schedule, sampling threshold
GET|PUT /api/traffic-map/node-info                 → what a node is (and an admin's own text)
GET  /api/traffic-map/environment                  → the band: name and tier
GET  /api/traffic-map/overhead                     → the map's own cost
GET  /api/traffic-map/compare/windows?…            → two windows from the request log
GET|POST|DELETE /api/traffic-map/breakers          → circuit breakers
GET  /api/traffic-map/history/timelapse?range=24h|7d → playback frames, people, markers
GET  /api/traffic-map/history/search?kind=…        → last hit, first error, busiest hour
GET  /api/traffic-map/history/route-latency?key=&route=&hours= → duration histogram
GET  /api/traffic-map/history/slow-params?key=&route=&hours=   → parameters of slow requests
GET  /api/traffic-map/history/jobs                 → scheduled jobs against the day's traffic
GET  /api/traffic-map/capacity/what-if?traffic_pct=&add_replicas=&job=&to_minute=
GET|PUT /api/traffic-map/history/settings          → minute history on/off, retention
GET  /api/traffic-map/blast-radius?node=           → what depends on a node (7 days)
POST /api/traffic-map/tell-affected                → broadcast to the people affected
GET|POST /api/traffic-map/debug-windows            → debug windows (DELETE /:id stops one)
GET|POST /api/traffic-map/temp-caches              → temporary caches (DELETE /:id stops one)
GET|PUT  /api/traffic-map/detectors                → detector settings for this environment
GET  /api/traffic-map/ext-lenses[/:key?window=]    → extension lenses and their data
socket  admin:join {room: 'traffic-map'}           → one 'traffic-map:frame' per second while watched`
    }
  ]
}

export const obsTrafficMapLenses: DocSection = {
  id: 'traffic-map-lenses',
  label: 'Traffic Map: Database, People & Platform',
  content: [
    {
      type: 'h1',
      id: 'traffic-map-lenses',
      text: 'Traffic Map: Database, People and Platform'
    },
    {
      type: 'p',
      text: 'Lenses for three questions the main map leaves open: what the database is waiting on, who is doing what, and which part of the platform carries the load.'
    },
    { type: 'h2', id: 'traffic-map-db', text: 'The database node' },
    {
      type: 'ul',
      items: [
        'Near timeout (on by default): requests whose longest database statement used 80% or more of the driver’s 15 s request timeout, or whose whole request used 80% or more of the proxy’s read timeout (`TRAFFIC_PROXY_TIMEOUT_MS`, default 60 s). Requests past a budget count as timed out. Those entities get an outline and a badge; the inspector lists the requests with how much of the budget they used, plus 24 hours from the request log.',
        'Blocking chains: while the map is open, the database is checked every 3 s for sessions waiting 0.5 s or more on another session’s locks. A red edge runs from the waiting request’s entity to the one holding it up, or to the database node when the holder is background work or another program. The database node names the head blocker and its statement, including an idle session holding an open transaction. Needs VIEW SERVER STATE; not in cloud mode.',
        'Deadlocks: every deadlock SQL Server recorded is a red marker on the sparklines at the moment it happened, named by the entities whose statements met. The database node lists them with the victim and the tables involved.',
        'Database time: a strip tile splitting the window’s database time between people (signed-in sessions), integrations (tokens and API keys), scheduled jobs, imports, flows and other background work. For the heaviest scheduled job it suggests the quietest hour of the day when the job runs in a busier one.',
        'Configuration cache: on the database node, how many configuration reads were answered from memory, how often a configuration write emptied the cache, and a hit-rate line carrying the change markers. Configuration-change markers name the table the write touched.'
      ]
    },
    { type: 'h2', id: 'traffic-map-people', text: 'People and callers' },
    {
      type: 'ul',
      items: [
        'Credentials about to fail: API key callers show a badge when the key expires within 7 days or is using 85% or more of its per-minute limit (counted the way the rate limiter counts). Partners show "token failing ×N" when their last two or more token exchanges failed. Select the node for details and a link to where you fix it.',
        'Follow a person: pick someone and the map rings their node and lights up what they touch as they move from page to page. A panel lists the screens they visited with request and error counts. "Keep full traces" records their next 50 requests in full. Only requests served by the process you are watching are seen.',
        'Data egress (More → Data egress): callers ranked by the rows list reads returned to them over the window, plus exports from the activity log: CSV and xlsx, export presets, PDFs, dossiers, backups and bundles. A read of 500 rows or more counts as large. GraphQL reads are not counted.',
        'Client crashes appear in the live events with links to the replay, seeked to the error, and to the issue.',
        'By role splits an entity’s requests by role, with API keys and machine accounts shown as Integrations.',
        'Recent payloads shows an API key’s or machine account’s last five logged request bodies and errors, with secrets masked. Only API-key and token writes keep their bodies.',
        'Old tabs: how many open tabs still run an old front-end build, or loaded against an older API, per app over the window. Follow "reload them" to /realtime (see Deploys & Versions).'
      ]
    },
    { type: 'h2', id: 'traffic-map-platform-lenses', text: 'Platform' },
    {
      type: 'ul',
      items: [
        'Owners: shades each node by how much of its load is Nivaro core versus each extension. Extension routes count wholly to their extension; other requests count by the time extension hooks ran inside them; partner calls count by the route, job or declared node that made them. Select a node for "Load by owner".',
        'Queue cache: a node that appears when a queue is materialized, showing rows resynced per write and their cost, failures, rebuild runs and time since the last rebuild, plus the lookup every business write pays.',
        'Nested resolver time: on a GraphQL operation, the time spent per nested field path (to-one, to-many, many-to-many, linked records) and per access check, summed over every row a list resolved. Measured only while the map is open.',
        'Dead letters: failed flow runs, and webhook deliveries that failed in the last day with nothing successful since, gather in one node with Retry and Discard on each item or on everything listed. Discarding keeps the run in the flow history; webhook deliveries can be retried but not discarded.',
        'Cloud operators: `GET /admin/traffic-tenants?window=300` (the provisioning path, cloud mode only) with the `x-provision-secret` header ranks the tenants this process served by database time, then requests, then errors.',
        'HTTP caching (More → HTTP caching): every GET route in the window with its share of 304 Not Modified answers (browser cache hits the server revalidated), conditional requests, repeats (the same caller fetching the same URL again within a minute) and the cache headers it sent. Routes a browser could cache (static content, or high repeats) that send no Cache-Control, ETag or Last-Modified are flagged first. Report only: no header is changed.'
      ]
    },
    { type: 'h2', id: 'traffic-map-security', text: 'Security' },
    {
      type: 'p',
      text: 'Badges on caller nodes, a Security section in the caller’s inspector and a Security panel (More → Security). Addresses and browsers are only shown to admins on this page; they are never sent on the live feed or kept in saved snapshots.'
    },
    {
      type: 'ul',
      items: [
        'Places: requests by country and region from the caller’s address, looked up on the server in an offline MaxMind database. Set `TRAFFIC_GEOIP_DB` to a GeoLite2 Country or City `.mmdb` file to turn it on; addresses are never sent anywhere. A caller’s places are learned in its first 15 minutes; a place first seen after that gets a "new place" badge for an hour. Not-signed-in traffic is never flagged.',
        'Scripted sessions: a person’s browser session that makes calls at a steady machine pace or in a fixed repeating loop from outside the app (the call carries no Nivaro app header, as from a browser extension or a script reusing the cookie), or whose client names a scripting tool such as curl. The panel shows the pattern and links to the person. The app’s own polling never flags.',
        'One session from two places: the same session going back and forth between two networks within five minutes, a possible copied cookie. Both addresses and browsers are shown. When the two sides use different browsers or countries, active admins get an in-app notification (once per person every 6 hours; never the person themselves; deployed instances only). Private addresses and the ranges in `TRAFFIC_KNOWN_PROXIES` (comma-separated CIDRs of shared gateways and VPN exits) are left out, and masquerade and View-as are not sessions.',
        'Wrong environment: calls whose Referer or Origin is another environment’s frontend or admin from the Environments registry, API keys this instance does not know (usually minted on another environment), and keys named for another environment.',
        'Bad data by caller: records whose after-write Data Integrity check found problems in the last 7 days, credited to the caller whose write came just before the check, with the rules broken and example records.'
      ]
    },
    { type: 'h2', id: 'traffic-map-partner-shapes', text: 'Partners and API shape' },
    {
      type: 'ul',
      items: [
        'Against what was agreed: set a response time (95th percentile, in ms) and an availability (percent) under External APIs → the partner → Agreed service levels. Select the partner node for the month so far, the share of judged hours that stayed inside both figures, and a 24-hour strip with the breached hours in red. An hour needs 3 or more calls to be judged. A call counts as available unless it is a 5xx or never arrived. Figures come from the outbound log, which is kept for 31 days.',
        'Payload shape: on a partner node, which fields it started sending, stopped sending or changed the type of. The usual shape is learned per endpoint from the JSON bodies the outbound recorder still holds (the last 24 hours), and the newest calls are compared with it. It needs 20 bodies per endpoint. Field names and types only, never values.',
        'Inbound mapping outcomes: on an inbound mapping’s node, payloads accepted (every entry written), partly accepted and rejected, with the top rejection reasons. Numbers and ids in a reason are folded together so the same cause counts once.',
        'Query cost: on a GraphQL operation, its depth, average selections, time in nested resolvers and whole-request time, the callers sending it, and its place among the most expensive operations. Resolver time is measured only while the map is open.',
        'Fields requested: on a collection, which fields callers ask for with `fields=` on REST list reads, how often, and who asks. `*` and a missing `fields` count together as "every column". Use it beside the filter and sort shapes when choosing an index or trimming a payload.'
      ]
    },
    { type: 'h2', id: 'traffic-map-other-features', text: 'The map beside other features' },
    {
      type: 'ul',
      items: [
        'Edit locks: a panel of records whose edit lock has been held 15 minutes or more, or that someone is waiting for. Each row names the holder, how long the lock has been held, how long since the holder’s browser last checked in (idle), the people waiting in order, and links to the record.',
        'Web and workers: when processes report a role (`NIVARO_ROLE` on the instance roster), a panel groups requests, errors, p95, background calls and pool use by role. It says so when background jobs ran on the web processes and none on the workers. A process with no role counts as "unset"; the panel stays hidden until at least one has a role.',
        'Business activity: per-minute counts of records created, workflow transitions, approvals decided, imports finished and partner pushes accepted, drawn beside the API’s own requests per minute for the last 15 minutes. When one of them falls to under 40% of its earlier rate while API traffic holds, the panel says so, so a quiet business is not mistaken for a quiet API. Counts only: no record values.',
        'Traffic on a support ticket: people who work a ticket see their requester’s requests, errors and pages for 30 minutes either side of the moment it was raised, with a link to that moment on the map (administrators only). The requester never sees it, and opening it leaves an activity row.'
      ]
    },
    { type: 'h2', id: 'traffic-map-people-experience', text: 'People and experience' },
    {
      type: 'p',
      text: 'One panel on the Traffic Map page, People and experience, with a switch between ten lenses. Each reads real browser timings, the request log, journeys, notifications or the AI call log, and shows the worst rows first. A request is given a page by the visit the person had open when it arrived, so a person with two tabs open is attributed to the most recent page.'
    },
    {
      type: 'ul',
      items: [
        'New people: calls per visit, p95, error rate and browser time for people in their first 7 days against everyone else, per page, with how much slower the first-week experience is.',
        'Browsers: per page, the p75 load and route time by browser, system and screen size class (phone, tablet, laptop, desktop, wide), flagging a value 1.5 times slower than the rest of the page. Only the class of the screen is stored, never the exact size. Timings from before this version carry no browser.',
        'Errors by person (admin only): people ranked by browser errors and failed calls, with the pages and the error text, so support can reach out first.',
        'Network or server: for each page, the median load split into the wait for the first byte (network), the slowest call the page waited on (server) and the rest (browser). It is an estimate.',
        'Apdex: satisfied up to the target, tolerating up to four times it, frustrated beyond. Defaults are 1 s for pages and 0.5 s for calls (`TRAFFIC_APDEX_PAGE_MS`, `TRAFFIC_APDEX_REQUEST_MS`), adjustable on the lens. Per page or per person, with the weekly scores beside the totals. The log keeps 14 days, so a trend has two or three weekly points.',
        'Sign-in: the path through sign-in as a funnel per method (Microsoft, SAML, password, token): login page, provider redirect, callback and first page, with failures and the p50 and p95 time between steps. Calls are tied together by address and browser.',
        'Screen flow: moves between screens as a flow diagram per app, heaviest first, with the calls each move costs in the destination screen’s first five seconds.',
        'Notification load: people who received 10 or more notifications in an hour (`TRAFFIC_NOTIFY_FLOOD_PER_HOUR`), with the hours, the channels, categories and senders responsible.',
        'AI spend: AI cost by screen, from the AI call log and the page the caller had open, and the same top screens on the AI provider node.',
        'Business heat: single-record reads and writes by the User Scope dimension value the record belongs to (a zone, a region, a project type), so one region’s month-end shows as that region. It counts only while the page is open, keeps no record values, and does not attribute list reads. Not available in cloud mode.'
      ]
    }
  ]
}
