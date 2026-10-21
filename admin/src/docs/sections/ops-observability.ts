import type { DocSection } from '../types.js'

export const dbHealthDocs: DocSection = {
  id: 'db-health',
  label: 'DB & Runtime Health',
  content: [
    { type: 'h1', id: 'db-health', text: 'DB & Runtime Health' },
    {
      type: 'p',
      text: 'The DB & Runtime page at /db-health (Monitoring → DB & Runtime) is a read-mostly console over the database server, Redis, and the API process itself. Every endpoint behind it is admin-only. Panels that need database-server visibility degrade honestly: if the database login lacks the VIEW SERVER STATE permission, the panel shows an amber note saying exactly that instead of failing.'
    },
    { type: 'h3', text: 'What the panels show' },
    {
      type: 'table',
      head: ['Panel', 'What it tells you'],
      rows: [
        [
          'This process',
          'Uptime, memory, event-loop lag, and connection-pool usage for the replica that answered — per process, not fleet-wide.'
        ],
        [
          'Instance roster',
          'Every live API replica registered in Redis (empty when Redis is down).'
        ],
        [
          'Cache console',
          'In-process caches on this replica, each with a Bust button (and a bust-all). Every bust is audit-logged.'
        ],
        [
          'Degradation map',
          'What stops working when each dependency (database, Redis, SMTP) goes down. Database and Redis are probed live.'
        ],
        [
          'Top expensive SQL',
          'The 15 statements costing the server the most CPU since its last restart. SELECT statements get an Explain button that opens the query plan.'
        ],
        [
          'Deadlocks',
          'Recent deadlock events mined from the server health session, with the statements involved.'
        ],
        [
          'Long transactions',
          'Sleeping sessions that have held an open transaction idle for 5+ minutes.'
        ],
        [
          'Unused indexes',
          'Nonclustered indexes with heavy writes and zero reads since the server last restarted.'
        ],
        ['Table heat', 'Read/write activity per table since the server last restarted.'],
        ['Redis', 'Memory, clients, keys, hit/miss counters, evictions.'],
        [
          'Storage runway',
          'Database size now, a daily growth rate from nightly snapshots, and the largest tables.'
        ],
        [
          'Held connections',
          'Checked-out pool connections attributed to the request holding them — the leak finder.'
        ],
        [
          'Data velocity',
          'Which collections are being created/updated the most, from the activity log.'
        ],
        ['Latency by hour', 'Slowest routes by hour of day (UTC) over the last 7 days.'],
        [
          'Dangling foreign keys',
          'Registered relations whose FK values point at rows that no longer exist, with guarded repair actions.'
        ],
        [
          'Redundant indexes',
          'An index whose key list is a strict prefix of another index on the same table — it answers nothing the wider one cannot and taxes every write. Filtered and unique coverers are never counted as covering. Drop goes through the same guarded path as unused indexes.'
        ],
        [
          'Backup tables',
          'Scratch copies a one-off fix left behind (zz_…, …_backup, …_bak): row count, size, age and the last time anything read them. Only tables that are not registered collections and that no foreign key references are listed; rows older than BACKUP_TABLE_STALE_DAYS (default 30) read amber.'
        ]
      ]
    },
    { type: 'h3', text: 'The write actions, and their guardrails' },
    {
      type: 'ul',
      items: [
        'Drop an unused index — only plain nonclustered indexes qualify: the server re-checks the index at drop time and refuses primary keys, unique indexes, and clustered indexes outright. Every drop is audit-logged with the index name. Remember the usage counters reset when SQL Server restarts, so "zero reads" on a recently restarted server is weak evidence — check the uptime first.',
        'Kill a long transaction — requires a typed reason (the KILL button stays disabled without one), only works on user sessions (session id above 50), and refuses to kill the console’s own connection. The reason lands in the audit log alongside the session id.',
        'Drop a backup table — two clicks, and only a table the listing itself returned qualifies: the listing is the allow-list, so a registered collection or a table some foreign key points at can never be dropped from here, whatever the name looks like. The drop is audit-logged with the row count and size it held.',
        'Dangling-FK repair offers two actions only: null out the broken reference (refused on NOT NULL columns) or delete the orphaned rows through the normal delete path, so trash, deletion guards, and hooks all apply. Repointing to a different record is deliberately not offered.'
      ]
    },
    { type: 'h2', id: 'config-since', text: 'Environment Config — what drifted since' },
    {
      type: 'p',
      text: 'The `config-snapshot` job stores a gzipped snapshot of every configuration table each night at 04:40 (secrets already stripped, pruned to the newest 30). Environment Config → **What drifted since…** picks any stored night and compares the live rows against it with the same engine the file upload uses — added, removed and changed rows per table, field by field. Nights identical to the one before are dimmed: a run of identical hashes is the answer "nothing drifted". **Store a snapshot now** takes one on demand. API: `GET /config-diff/history`, `POST /config-diff/history`, `GET /config-diff/since?id=|at=`.'
    },
    { type: 'h2', id: 'layout-drift', text: 'Layout drift' },
    {
      type: 'p',
      text: "Every layout mutation snapshots the state before it, so the newest version against the current rows is exactly **what the last save changed**. Table Editor → Version history shows that diff first and any version's diff on demand (assignments keyed by field, since the save route re-inserts rows; groups by id), with warnings for the shapes that meant damage before — column widths nulled wholesale, slot flags flipped off together, half the fields gone. The readiness check `layout-drift` sweeps every layout for those shapes. API: `GET /collection-layouts/:id/versions/:v`, `…/versions/:v|newest/diff?against=current|<v>`, `GET /collection-layouts/drift`."
    },
    {
      type: 'h2',
      id: 'custom-query-dependents',
      text: 'Custom queries — used by, and procedure shape'
    },
    {
      type: 'p',
      text: 'The query editor\'s **Used by** card lists everything that references the query by slug or id — page widgets, record widgets, report widgets and catalog presets, metric and anomaly definitions, flow operations, other queries. Below it, **Procedure shape** checks each `INSERT … EXEC` in the wrapper against the procedure\'s real first result set: INSERT … EXEC binds by position, so the declared column COUNT must equal what the procedure returns; names are shown but never fail the check. SQL Server cannot describe a procedure that builds temp tables inside — those read "cannot be described", and the last failing run on this process (a shape error) is the honest fallback. The readiness check `custom-query-shapes` runs the same comparison over every wrapper. A **Temp tables** card below it lists every `#temp` the wrapper builds and whether it is dropped first (`IF OBJECT_ID(\'tempdb..#x\') IS NOT NULL DROP TABLE #x` or `DROP TABLE IF EXISTS #x` before the build): a batch that fails between CREATE and DROP leaves the table on the pooled connection, and the next wrapper on that connection dies "There is already an object named #x". The same readiness check warns on every enabled wrapper with an unguarded temp table. API: `GET /custom-queries/:id/dependents`, `GET /custom-queries/shape-report`.'
    },
    { type: 'h2', id: 'dead-columns', text: 'Dead columns' },
    {
      type: 'p',
      text: "Columns a model change left behind are registered in `api/src/db/dead-columns.ts` with the date the last writer stopped, what replaced them and whether they can be dropped yet. `pnpm --filter @nivaro/api run dead-columns:check` greps every source tree and fails when code still names a column marked droppable; the readiness check `dead-columns` reports droppable columns still present on the database (the dropping migration has not run there) and lists what still blocks the retiring ones. `GET /ops-db/dead-columns` is the same view. Migration 336 dropped the first one, the queues table's retired view-mode column."
    },
    { type: 'h2', id: 'proc-transaction-guards', text: 'Open transactions on the pool' },
    {
      type: 'p',
      text: 'A stored procedure that opens a transaction without `SET XACT_ABORT ON` and then fails leaves the transaction open: the batch stops, the connection goes back to the pool mid-transaction, and the next caller on that connection inherits it. Every raw EXEC path now rolls an open transaction back on the same connection before releasing it (custom queries, rule `exec_procedure` actions, long-running statements), and the readiness check `proc-transaction-guards` lists every procedure with `BEGIN TRAN` that carries neither `SET XACT_ABORT ON` nor a CATCH that rolls back. `GET /api/ops-db/proc-transaction-lint` is the list as JSON. A request-timeout cancellation skips a CATCH, which is why the connection-level rollback stays.'
    },
    { type: 'h2', id: 'erp-payload-retention', text: 'ERP push payload retention' },
    {
      type: 'p',
      text: 'Every ERP push stores its payload and response. Settings → `erp_submission_payload_retention_days` (default 90; blank or 0 keeps forever) makes the daily retention pass blank both on rows older than the window — status, attempts, last error, external reference and change signature stay, so history and the push-only-when-changed gate are untouched. `GET /erp-submissions/storage` reports rows, bytes, the oldest row still carrying bytes and how many the next pass will blank; `POST /erp-submissions/storage/prune` runs it now.'
    },
    { type: 'h2', id: 'cache-health', text: 'Cache health (custom queries)' },
    {
      type: 'p',
      text: 'Custom Queries → the Cache health card shows, per query, how it has been answered since this API process started: cache hits, misses, viewer refreshes and uncached runs, the average and maximum execution time, and what the cache spared — hits × average execution. It names the queries worth a look: never cached but seconds a run, cached but rarely hit (parameters vary per viewer, or the TTL is shorter than the gap between views), or refreshed more than read. Fourteen of thirty-three budget queries sat at a TTL of 0 — four of them the slowest — and nothing surfaced that before.'
    },
    {
      type: 'p',
      text: 'A cached figure also carries its staleness in business terms. Each query names — or has inferred from its SQL and the procedure it EXECs — the tables whose newest write decides whether the figure is still true; the stamp reads "invoices changed 4m ago — newer than this figure" (amber) or "· current" beside "Updated 3m ago". Declare the sources on the query as `[{"table": "invoices", "column": "changed"}]` when the inference picks the wrong tables.'
    },
    { type: 'h3', text: 'TTL suggestions' },
    {
      type: 'p',
      text: 'The Cache health card opens with a Suggestions list: enabled queries with a cache TTL of 30 s or less that average at least 0.5 s a run and have run at least 5 times since boot. For each it shows the 1, 5 and 15 minute options side by side — time saved per day (calls the cache would answer × average run) and the staleness window the TTL introduces ("figures up to 5 min old"). The recommended option is the shortest one that earns at least 70% of the best saving. Review opens the three options; Accept sets the query\'s cache TTL through the normal edit route, so it is recorded in the activity log like any other change. Nothing is applied automatically: every accepted TTL is a window someone agreed to. Savings are an upper bound (they assume one cache key; parameters and User Scope values are part of the key, so a varying query saves less), and a card with under 6 hours of observation says so.'
    },
    {
      type: 'warn',
      text: 'A query that may write is never offered a TTL, because a cached write silently stops writing. The query text and every procedure it EXECs (followed through nested EXECs, up to 8) are checked for INSERT / UPDATE / DELETE / MERGE / DROP / dynamic SQL and system procedures; writes into #temp tables and @table variables are ignored. A procedure whose text cannot be read counts as unsafe. Withheld queries are listed under the suggestions with the reason.'
    },
    {
      type: 'p',
      text: 'Traffic Map → Hot entities has a Cache hit column for custom-query and widget rows (hit share over the last 60 s; a query with no TTL never records a hit and reads "—").'
    },
    { type: 'h3', text: 'Shared runs and the heavy-read gate' },
    {
      type: 'p',
      text: 'When several viewers ask the same custom query with the same parameters at the same moment, and the answer is not cached, the query runs once and every caller gets that result. This also applies at a cache TTL of 0, where nothing is kept after the run ends. Each caller is checked for access on its own, and the cache key already carries their User Scope values, so a run is only shared between callers who would get the same answer. A failed run is not reused. Widget renders and the owner-load report work the same way. The Cache health card counts shared answers as `shared_runs`.'
    },
    {
      type: 'p',
      text: 'The expensive reads also go through a gate: custom-query and widget runs that miss the cache, each live (non-materialized) queue worklist source, and owner load. Cache hits and cheap routes do not. By default a process allows a third of `DB_POOL_MAX` at once (at least 4; set `HEAVY_READ_CONCURRENCY` to change it); in cloud mode each tenant has its own gate of one less than its pool size. While other people are waiting, one person holds at most 4 (`HEAVY_READ_PER_USER`); alone on a quiet server they may use every slot. Further requests wait in arrival order, and a shared run starts as soon as any of its callers gets a slot. A request that has waited `HEAVY_READ_MAX_WAIT_MS` (30 s) runs anyway, so the gate never turns slowness into an error; a request whose browser leaves while it waits stops waiting, but a query that has started always runs to the end. A request that waited sends `Server-Timing: gate;dur=<ms>`, and one that used a shared run sends `flight;desc="shared"`. `GET /api/health/detailed` → `read_gate` shows the current state and counts since boot: active, queued, waits, timeouts, aborts and shared runs.'
    },
    { type: 'h2', id: 'cache-warm', text: 'Cache warm after boot and before business hours' },
    {
      type: 'p',
      text: 'A nightly database rebuild leaves the first dashboard of the day on a cold database and an empty query cache. The cache-warm job (weekdays 06:30, and about 20 seconds after a boot) pre-runs, as an unrestricted caller, only two kinds of custom query: cached ones (cache TTL above 0) among the 25 opened most in the last 7 days (development instances not counted), and every query flagged "Warm daily". Each runs with its default parameters and up to 3 of its most-used parameter sets, and its result is stored under the cache key the custom-query execute route reads for every unrestricted viewer — the key Ask AI and dashboards that call that route hit. A key cached within the last hour is left alone. Then, in the same budget, the viewer phase fills the entries that key differs for: custom-query widget renders (their key is the widget’s bound parameters after the viewer’s User Scopes) for the 25 widgets rendered most, and execute calls by people whose User Scopes narrow a query that declares scope parameters. It computes AS the people who used them in the last 7 days: active accounts, grouped by scope signature (administrator, or the exact set of restrict-mode allowances) — the cache key is per scope value, not per person, so 200 people with the same allowance cost one run, made as the group’s most frequent viewer through that person’s own access check and scope injection; up to 20 signatures per widget or query. Each widget runs its default bound values (when every binding has a default) and its 3 most-seen recorded bound sets (the render route records them for cached widgets). Defaults run first, most-used first. Every run takes a heavy-read slot under the same single-flight key the viewer’s request uses, so a viewer who misses meanwhile joins the warm’s run. Only cached queries (cache TTL above 0) are ever run by usage. Extension warmers (`ctx.cache.registerWarm`) run last, each with its own timeout inside what is left of the budget. The viewer phase and extension warmers run on the boot and 06:30 warms only, never in cloud mode. A "Warm daily" query with no cache TTL still runs (that warms the database) and its rows are dropped; the 06:00 query-cache-warmers job runs every "Warm daily" query, always overwriting its entry, with no overall budget. The boot warm runs once per cluster per version and takes the heavy-job slot; a run stops starting queries when its time budget (`CACHE_WARM_BUDGET_MS`, 4 minutes) is spent, and each query has a 90-second timeout. `CACHE_WARM=off` turns the boot and 06:30 warms off; `on` forces them on a process that does not tick scheduled jobs. Ops Console lists the job as `cache-warm`, with Run now and Dry run.'
    },
    {
      type: 'p',
      text: 'Queue worklists warm in the same run, after the viewer phase and inside the same budget. The warm replays the first pages people actually opened in the last 7 days: `GET /api/queues/:id/items` requests with no page or `page=1`, from the request log, development instances not counted. People are grouped per queue by what their read costs, which is their access (administrator, or role plus restrict-mode User Scopes), not their tab, sort or filters. Each group gets one read, made as the person who sent the group’s most-used request, through the route’s own query parser and queue access check. Up to 12 reads run, most-used first, one at a time, each source taking its own heavy-read slot. Nothing the warm reads is stored or shown to anyone: queues have no result cache. The read only leaves the database pages, query plans and in-process caches it touched warm, the same ones the person’s own request would fill. It never writes: it skips the materialization promotion a large live queue would queue, and it calls the service directly, so it adds no request-log row and no last-access time. Every process also warms what a queue read pays once per process: the source collections’ metadata and the predictive-SLA percentiles. Owner groups already warm at boot. Like the viewer phase, the queue phase runs on the boot and 06:30 warms only, and never in cloud mode. Dry run lists it under `queues`.'
    },
    { type: 'h3', text: 'Pool pressure' },
    {
      type: 'p',
      text: 'The process panel reports the connection pool over the last five minutes, not at the instant you looked: p50 / p95 / max time a request WAITED for a connection, and the share of the window with every connection busy. Identical 80ms statements once read 2.2s because that wait was invisible — no query timing shows it. The pool-monitor job raises an issue when the p95 wait passes 500ms or the pool sits full for a quarter of the window.'
    },
    { type: 'h3', id: 'background-pool', text: 'Background connection pool' },
    {
      type: 'p',
      text: "Background work has its own connection pool, so a person never waits for a connection a background job is holding. Background work here means scheduled jobs (including dry runs and catch-up runs), staged and CSV imports, queue rebuilds, the cache warm after boot and other boot-time warms, and anything that holds the heavy-job slot, such as help-video renders. Requests use the main pool (`DB_POOL_MAX`, default 60). Background work uses `DB_POOL_BACKGROUND_MAX` (default 10). Both pools connect to the same server and database, so one process can open up to `DB_POOL_MAX + DB_POOL_BACKGROUND_MAX` connections; budget that against the server's connection limit for each replica. The background pool opens connections only when it needs them and closes idle ones, so a process with no background work holds none. Set `DB_POOL_BACKGROUND_MAX=0` to turn the separate pool off; background work then shares the main pool, as it did before."
    },
    {
      type: 'p',
      text: "No code changes are needed to use it: the `db` handle checks, on every call, whether the current work is background work and picks the pool to match. Everything a job awaits uses that pool too, including timers it sets and promises it starts. A transaction stays on the one connection it opened. Long-running statements (`runLongSql` / `withLongConnection`) take their connection from the same pool. An admin's \"Run now\" runs the job on the background pool, while the request that asked for it, and the job-run record, use the main pool. Before a heavy job starts, it waits until the background pool has room. In cloud mode, a tenant's work always uses that tenant's own pool, and no background pool is created."
    },
    {
      type: 'p',
      text: 'DB & Runtime Health shows both pools: "Pool · requests" and "Pool · background jobs", with in-use count, waiting count, p95 wait and the most connections this process can open. Held connections are listed with the pool that holds them. `GET /api/ops-db/pool` keeps the main pool at the top level (as before) and adds `background` (null when the pool is off) and `total_max`. `GET /api/ops/runtime` adds `background_pool`, and `/api/metrics` adds `nivaro_db_background_pool_used`, `_pending` and `_max`. The heavy-read gate is still sized from the main pool (`HEAVY_READ_CONCURRENCY`, default `max(4, DB_POOL_MAX/3)`).'
    },
    {
      type: 'note',
      text: 'Storage runway needs at least 7 nightly snapshots before it projects a growth rate — until then it reports how many snapshots it has collected. Snapshots are written by the storage-snapshot job at 03:45 daily.'
    }
  ]
}

export const opsConsoleDocs: DocSection = {
  id: 'ops-console',
  label: 'Ops Console',
  content: [
    { type: 'h1', id: 'ops-console', text: 'Ops Console' },
    {
      type: 'p',
      text: 'The Ops Console at /ops-console (Monitoring → Ops Console) is the operational side of the API process: the live log, log-based alerting, environment inspection, maintenance windows, and controlled restart. Admin-only throughout.'
    },
    { type: 'h2', id: 'ops-console-crons', text: 'Scheduled jobs: pause, override, revert' },
    {
      type: 'p',
      text: 'Background Jobs (Monitoring nav) lists every cron the process registered — core schedules and extension-registered ones alike — with its effective schedule, last outcome and next run. Each row can be paused/resumed, run now, and have its schedule OVERRIDDEN from the admin: click the expression, type a new cron expression (the next fire times preview live; an invalid expression is refused with the parser message), Save. Revert puts the job back on the schedule its code registered.'
    },
    {
      type: 'ul',
      items: [
        'Overrides persist in settings.cron_overrides and are hydrated before extensions register, so an override binds to an extension job on every replica after a restart — no deploy needed.',
        'Pause keeps the job registered but its ticks return immediately (settings.paused_crons); Resume is instant.',
        'API: GET /api/cron (effective + default expression, override metadata), GET /api/cron/preview?expression=, PATCH /api/cron/:id {expression | null, note}, POST /api/cron/:id/revert, /pause, /resume, /run. Every change is activity-logged (cron-override, cron-revert, cron-pause, cron-resume, cron-run-now).',
        'Flows have the same enable/disable from the Flows list (the Power action on a row) — an inactive flow keeps its config and its version history; the editor’s Versions panel reverts config.',
        'Dry run (#32) — a job that registered a dry-run handler shows a "Dry run" button: it reports what a tick would do with nothing written (the rollup drift sweep lists stale rows without raising an issue; the miss detector lists missed windows; the query warmers list the queries they would run). API: POST /api/cron/:id/dry-run.',
        'Run after (#54) — the per-row select chains a job after another one: its own schedule goes dormant (ticks are no-ops, the expression stays registered as the revert target) and it runs right after the chosen job completes, in registration order when several chain on one parent. Cycles are refused. Persisted in settings.cron_chains and hydrated at boot before any schedule registers. API: PATCH /api/cron/:id {after: id | null}.',
        'Miss detector (#81) — cron-miss-detector runs every 30 minutes: for each job not paused or chained it derives the previous expected fire time from the schedule and, when no run has been recorded since (past a grace of 10% of the period, five minutes minimum, and never for a window before this process booted), raises one deduped issue naming the window.',
        'Heavy jobs yield (#75) — a job marked heavy waits while the connection pool is hot (80% checked out or acquires queued), in five-second steps for up to ten minutes, before taking its serialized turn; interactive requests win the morning rush.'
      ]
    },
    { type: 'h3', text: 'Gated jobs' },
    {
      type: 'p',
      text: 'A job that no-ops behind a deployment flag says so on the Background Jobs page: a green `<FLAG> on` badge when the flag names it, an amber `<FLAG> off · inert` badge when every tick returns without doing anything. Extensions declare it with `cron.annotate(id, { gate: { flag, enabled } })`; a readiness check can still add up the coverage, but the per-job truth sits beside the job.'
    },
    { type: 'h2', id: 'ops-console-logs', text: 'Log tail and log alert rules' },
    {
      type: 'ul',
      items: [
        'Log tail — the last 2,000 log lines from this replica, held in memory (nothing is persisted), auto-refreshing every 10 seconds with level filters and a plain-text search. It captures structured logger output; anything printed with bare console.log goes to stdout only and will not appear here.',
        'Search the tail with a regular expression (the .* toggle, case-insensitive; an invalid pattern falls back to a plain substring match) and bound it with since / until — an ISO datetime, epoch milliseconds, or the relative forms now-15m, now-2h, now-1d (#82).',
        'Log alert rules — a rule is a name plus a regular expression (optionally with a minimum level). When a log line matches, an issue is raised in the Issue Log; a 5-minute per-rule cooldown keeps a noisy line from raising the same issue every second. Rules apply as lines arrive, on every replica. A rule may also carry a threshold ("10 matches in 15 minutes") and its own cooldown, and a rule saved from Ask the logs can watch the request log instead — see Ops assistant.',
        'Keep patterns simple: patterns longer than 200 characters, or ones using nested quantifiers (the shapes that can hang a regex engine), are accepted but quietly never match — if a rule seems inert, shorten and simplify its pattern.',
        'Silent failures — a counter panel for deliberate catch-and-continue sites in the code, showing how often each has fired since this process started. A site firing 50 times in an hour raises an issue on its own.'
      ]
    },
    { type: 'h2', id: 'ops-console-incident', text: 'Incident timeline, clock audit, environment' },
    {
      type: 'ul',
      items: [
        'Incident timeline — pick a moment and build a merged timeline of everything within ±60 minutes: issues, failed or interrupted background jobs, and configuration changes. Made for "what changed around 14:00" questions.',
        'Clock & DST — measures the clock skew between the API and the database (flagged red past 5 seconds) and lists scheduled jobs whose hour falls in the 0–3 AM band that daylight-saving transitions can skip or repeat.',
        'Environment knobs — every configuration variable the process was started with, plus the documented raw-env switches. Values are masked two ways: any key whose name suggests a secret (secret, token, pass, key, credential, signing) shows as dots, and any value shaped like a credential-bearing URL has its password segment replaced — so connection strings are safe even under innocent key names.'
      ]
    },
    { type: 'h2', id: 'ops-console-migrations', text: 'Migrations card' },
    {
      type: 'p',
      text: 'The Ops Console lists what this build carries versus the migration ledger: pending migrations with their source (so the DDL a restart will run can be read first) and the newest applied ones with timestamps. Pending is normally empty — boot applies migrations — so a non-empty list means a restart is about to change the schema, or a replica is serving mid-deploy. API: GET /api/ops-runtime/migrations (#68).'
    },
    {
      type: 'p',
      text: 'Each applied migration also shows what it DID: the schema is listed before and after every run and the difference is stored beside the ledger (nivaro_migration_effects — tables, columns, indexes, foreign keys and procedures added or removed, with the duration). A migration whose row reads "no schema change" either found its objects already in place or only touched data; the ledger alone cannot tell those apart, which is why the row exists. Migrations that ran before this was tracked say so.'
    },
    { type: 'h2', id: 'ops-console-maintenance', text: 'Maintenance mode and windows' },
    {
      type: 'p',
      text: 'Maintenance mode freezes every write for non-admins while reads keep working; admins stay exempt so they can do the work. Scheduled jobs hold too \u2014 a tick that lands during the freeze is skipped and the job resumes on its next schedule once it lifts (Run now still works, and the sweep that ends a maintenance window keeps ticking). Turn it on by hand from Security Center (Operations → Security Center → Maintenance mode) or let a scheduled window flip it. People are told what the freeze means in one of two presentations: a strip above the app (Banner — browsing works, saving is paused, anything saved earlier is unaffected) or a page that replaces the app until the freeze lifts (Full page — the portal is unavailable until maintenance ends, earlier saves are safe). Admins always get the strip. The optional "Expected back" time shows on the page with a countdown, and the page checks every 30 seconds and returns people to the app on its own the moment maintenance ends. A write refused during the freeze answers 503 with code MAINTENANCE and the same explanation. A maintenance flag can also come from outside the database — a rebuild job that restores the database cannot keep a row there, so it sets the Redis key nvr:maintenance, which the platform honours above the settings row; the Security Center card says "Set by a rebuild job" when that is the source, and End maintenance clears it.'
    },
    {
      type: 'p',
      text: 'A maintenance window is a scheduled freeze with a lifecycle the platform runs for you. Create one with a title, start, end, optional message and the presentation (banner or full page); from there it is automatic:'
    },
    {
      type: 'ul',
      items: [
        'Pre-announce — once the start is under 24 hours away, a warning banner appears for everyone with a countdown and the local start–end times.',
        'Start — a per-minute sweep flips maintenance mode on at the boundary, carrying the window’s presentation and its end time as the expected-back time. Non-admin writes are refused while it is on, the banner switches to a non-dismissable notice (or the full page takes over), and the alert engines (ops monitors, alert definitions, report alerts) pause — their skipped evaluations are not queued up, they simply do not run.',
        'End — the sweep flips maintenance mode off and runs a smoke check (database, Redis, migrations, registered collections, and a self-request). Only when it passes is the "Maintenance complete" all-clear broadcast sent; a failed check raises a high-severity issue instead and holds the all-clear.',
        'Cancel — deleting an active window turns maintenance mode off immediately. The smoke check can also be run by hand at any time from the same card.'
      ]
    },
    {
      type: 'h2',
      id: 'ops-console-restart',
      text: 'Restart, follow-user, heap snapshot, CPU profile'
    },
    {
      type: 'ul',
      items: [
        'Restart — the Restart button requires a typed reason (audit-logged) and is refused while work is mid-run: running background jobs, staged imports, or processing collection imports each block it, and the refusal names what is running. The process exits cleanly and relies on the host’s restart policy to come back.',
        'Follow a user — pick a person and their next 50 requests are traced in full detail (per-phase waterfalls), regardless of how fast they are. Traces appear on the API Analytics page; a follow expires after an hour on its own.',
        'Heap snapshot — captures a V8 heap snapshot of this replica and downloads it for analysis in Chrome DevTools. The file lives in the process’s temp directory, so download it right away — a restart discards it.',
        'CPU profile — `POST /api/ops-runtime/cpu-profile` with `{"seconds": 1–30}` (admins only) samples this replica’s main thread while you reproduce the slow screen, then answers with where the time went: self time by function, time by source file or package, and time by Nivaro’s own functions. The full `.cpuprofile` downloads from `GET /api/ops-runtime/cpu-profile/<name>` for Chrome DevTools; like the heap snapshot it lives in the temp directory until a restart. One profile runs at a time, no debug port is opened, each run is logged in Activity, and it is refused in cloud mode.'
      ]
    }
  ]
}

export const opsAssistantDocs: DocSection = {
  id: 'ops-assistant',
  label: 'Ops assistant',
  content: [
    { type: 'h1', id: 'ops-assistant', text: 'Ops assistant' },
    {
      type: 'p',
      text: 'Administrator tools that use AI to read operations data — never to change it on its own. Ask the logs turns a question into the request list’s own filters; log alerts can be saved from a question or accepted from suggestions; in an admin-only chat channel the assistant answers from live operations data and proposes actions as approval cards; incident mode keeps a running thread in the ops channel.'
    },
    { type: 'h2', id: 'ops-ask-logs', text: 'Ask the logs' },
    {
      type: 'p',
      text: 'On API Analytics and the Ops Console: type "errors for Beth yesterday afternoon" or "who called /items/orders most today". The question becomes the same filter object the request list uses (path, method, status class, caller, auth kind, errors, a time window, or "rank by caller / path"; or level + text over the server log). The filter shows as chips before anything runs — take any chip away. Run reads the normal admin routes (`GET /api/api-analytics/requests`, which now takes `group=caller|path` for a top-20 ranking, or `GET /api/ops-logs/tail`); "Open in the request list" fills the full list below. A person named in the question is matched to accounts on the server; when several match, pick one.'
    },
    {
      type: 'note',
      text: 'What reaches the AI provider: the question (scrubbed of tokens and secrets), the filter’s field names and allowed values, and the current time and your time zone. Never a log line, a path list or a list of people.'
    },
    {
      type: 'pre',
      code: `POST /api/ops-logs/ask { "question": "errors for Beth yesterday afternoon" }   (admin)
→ 200 { "data": { "filter": { "target": "requests", "errors": true, "user": "<id>", "user_label": "Beth Ng", "from": "…", "to": "…" },
                  "chips": [...], "summary": "…", "person_query": null, "people": [] } }`
    },
    { type: 'h2', id: 'ops-log-alerts', text: 'Alerts from a question, and suggested alerts' },
    {
      type: 'ul',
      items: [
        '"Save as alert" stores the question’s filter as a log alert rule with a threshold, a window and a cooldown ("10 matches in 15 minutes, then quiet for 60"). A request-log rule is checked every 5 minutes (`log-alert-requests` job) across every server, against its own window — the question’s time words do not carry over; development instances never count. A server-log rule keeps working on each server as lines arrive.',
        'Suggested log alerts (Ops Console) lists errors that keep coming back with no rule watching them: failing requests over the last 24 hours that happened in at least two different hours, and error lines in this server’s log seen in at least two different minutes. Each comes with the filter or pattern, a threshold (about twice the busiest quarter-hour) and a cooldown; Accept saves it as shown (origin "suggested"), Dismiss hides it in your browser. No AI is involved.',
        'Rules: `POST /api/ops-logs/rules { name, pattern?, level?, filters?, threshold?, window_minutes?, cooldown_minutes?, origin? }`, `PATCH /api/ops-logs/rules/:id { is_active?, threshold?, window_minutes?, cooldown_minutes? }`, `GET /api/ops-logs/rule-suggestions`. Filters, thresholds and cooldowns need migration 442 (409 MIGRATION_PENDING before it).'
      ]
    },
    { type: 'h2', id: 'ops-chat-tools', text: 'The assistant in an ops channel' },
    {
      type: 'p',
      text: 'In an admin-only channel — a private or admin-role channel whose every member is an active administrator, checked against the database each time a question is asked — an administrator can mention the assistant: "anything failing right now?", "why is the queue slow?". It reads request volume and errors, slow paths, circuit breakers, open issues, running / failed / paused background jobs, recent imports, failed partner pushes and readiness. In any other room, or for anyone who is not an administrator, the tools are not offered and a call is refused.'
    },
    {
      type: 'p',
      text: 'It may propose one action as an approval card: pause a background job, refuse or rate-limit a noisy caller or entity for some minutes (a circuit breaker), retry a failed partner push, or turn incident mode on or off. Nothing runs until an administrator presses Approve. Approval re-checks the approver and runs the action through the same admin route a person would use (`/api/cron/:id/pause`, `/api/traffic-map/breakers`, `/api/erp-submissions/:id/retry`, `/api/ops-assistant/incident`), as the approver; one decision per card; every proposal, approval and dismissal is logged as activity, and the outcome is posted under the card. People who are not administrators see only a link.'
    },
    {
      type: 'note',
      text: 'What reaches the AI provider from an ops channel: counts, method + path patterns (ids replaced by *), job ids and labels, issue titles, collection names and submission ids, scrubbed of tokens. Never request bodies, record values or people’s names.'
    },
    { type: 'h2', id: 'ops-incident-threads', text: 'Incident mode and incident threads' },
    {
      type: 'ul',
      items: [
        'Pick the ops channel on the Ops Console (it must be admin-only; `PUT /api/ops-assistant/channel { room }`). If it later stops being admin-only, threads go quiet.',
        'The ops channel, and any channel already holding assistant ops posts, only ever gains active administrators: joining, adding, bulk-adding and default-role auto-join refuse anyone else (403 `OPS_CHANNEL_ADMINS_ONLY`), and the channel cannot be opened to everyone or to a non-admin role. Every assistant ops post is flagged, and message lists, search, mentions, pins, saved messages and room summaries leave flagged posts out for anyone who is not an administrator.',
        'Start incident mode from the Ops Console or an approved card (`POST /api/ops-assistant/incident { on: true, title }`). The assistant opens a thread in the ops channel and, every 2 minutes (`ops-incident-updates` job), posts what changed: new issues, server errors starting, rising, falling, recovering — plus every approved action. Ending it posts a summary: duration, the 5-minute error peak, issues seen and actions taken.',
        'While incident mode is on, every administrator sees a slim banner across the app — "Incident in progress: <title> · started <time> · Open thread" (the ops channel). It appears and clears live: starting or ending sends a payload-free `ops:incident` notice to the admin-only `ops` watch room, and the tab re-reads `GET /api/ops-assistant/incident` (admin-only). Non-administrators never join the room or ask the route, and see nothing.',
        'A critical alert (a new critical issue, or a critical integration signal with new rows) opens its own alert thread when no incident is on, feeds the incident thread when one is, and an alert thread closes with a summary after 30 quiet minutes.',
        'Threads live in `nivaro_ops_incidents` (migration 442); `GET /api/ops-assistant/incident` returns the current one and the last ten.'
      ]
    }
  ]
}

export const deploysVersionsDocs: DocSection = {
  id: 'deploys-versions',
  label: 'Deploys & Versions',
  content: [
    { type: 'h1', id: 'deploys-versions', text: 'Deploys and Versions' },
    {
      type: 'p',
      text: 'The checks that tell you a deploy really landed, which versions are running where, and what changed shortly before something went wrong.'
    },
    { type: 'h2', id: 'deploys-gate', text: 'The post-deploy gate' },
    {
      type: 'p',
      text: 'An API answering its new version is not enough: an extension mount can fail or readiness can drop while `/api/version` still answers. After a release, the verify stage (and the staging deploy gate) requires:'
    },
    {
      type: 'ul',
      items: [
        '`GET /api/ready` answers 200.',
        '`GET /api/preflight` does not fail.',
        '`POST /api/ops-runtime/smoke?strict=1` passes.',
        'The readiness score is no lower than a snapshot taken just before the deployments were pushed. Both reads run every check live (`GET /api/readiness?fresh=1`). It is read again once after a minute before the stage fails.'
      ]
    },
    {
      type: 'p',
      text: 'The Release card passes each API’s token from the Environments registry to the chain through its environment. Without a token only `/api/ready` is checked, and the plan says so; a token the API refuses fails the stage, so update it under Environments and resume from verify. On staging the extra checks run when the masked CI variable `STAGING_GATE_TOKEN` is set. A failing database or cache alone only warns, since the previous image would meet the same database.'
    },
    { type: 'h2', id: 'deploys-stage-timing', text: 'Release stage timing' },
    {
      type: 'p',
      text: 'Each release run stores how long each stage took, worked out from the run’s log. The Release card’s Stage timing table shows a trend per stage and highlights the slowest stage of each release. `GET /api/release/timings` returns the same.'
    },
    { type: 'h2', id: 'deploys-env-presence', text: 'Environment variables across environments' },
    {
      type: 'p',
      text: 'Environments lists every environment variable the loaded extensions declare, per registered API, as set or unset. Values are never read. A variable set on one environment and missing on another is listed at the top ("EFP_OPS_TAKEOVER is set on staging, missing on production"). A component running an older build reads "older version" rather than missing.'
    },
    {
      type: 'pre',
      code: `GET /api/environments/env-presence/local   → this instance
GET /api/environments/env-presence         → every registered API, compared`
    },
    { type: 'h2', id: 'deploys-tab-versions', text: 'Open tabs by version' },
    {
      type: 'p',
      text: 'Every front end reports the build it runs on each call (`x-nivaro-client: build=…; api=…; tab=…; loaded=…`) and in the socket’s `client:hello`. /realtime → Sockets & rooms lists open tabs per app and build, against the API version they first talked to. An app’s current build is the one its newest page load reported. Force client refresh → Old versions reloads only tabs on another build, or loaded before the API update; like the app filter, it reaches sockets on this API process only. The Traffic Map’s Old tabs tile shows the same count over its window.'
    },
    {
      type: 'p',
      text: 'A custom front end reports its build with `setClientBuild` / `installPageContextFetch({ build })`. A tab that reports nothing groups as "Not reported"; builds named `dev` are never judged old.'
    },
    { type: 'h2', id: 'deploys-readiness-cache', text: 'How fresh the readiness scorecard is' },
    {
      type: 'p',
      text: 'A plain `GET /api/readiness` (the dashboard card, the Go-Live Readiness page) answers from the stored result of each check, at once. Every check carries `computed_at` (when it ran) and `stale`; the report carries `computed_at` (its oldest result), `stale`, `refreshing` and `fresh`. A result older than its window is shown as it was, flagged stale, and one background refresh re-runs it, six checks at a time (`READINESS_REFRESH_CONCURRENCY`) on one process per cluster (a Redis lock), and the finished scorecard reaches open pages over the live-ops socket.'
    },
    {
      type: 'ul',
      items: [
        "Window: 5 minutes (`READINESS_TTL_MS`). A heavy check — one that declares `cost: 'heavy'`, or whose last run took 2 seconds or more — gets 30 minutes (`READINESS_HEAVY_TTL_MS`). A check can set its own `ttlMs` on registration.",
        'Results are stored per tenant and per API version, so a deploy starts empty. A deployed instance evaluates them about 15 seconds after boot (`CACHE_WARM`, which follows the cron switch when unset). Until a check has run on this version it reads `pending`, and the score stays empty until none is pending.',
        '`?fresh=1` (administrators) runs every check live. It is shared: a second fresh read joins one already running, and one within 10 seconds of a finished run gets that run. The page’s Re-run checks button, the release gate and the daily score snapshot use it.',
        'A check that takes longer than two minutes reports an error rather than holding the scorecard.'
      ]
    },
    { type: 'h2', id: 'deploys-readiness', text: 'Readiness checks for the deploy shape' },
    {
      type: 'table',
      head: ['Check', 'Warns when'],
      rows: [
        [
          'Every API process runs one version',
          'The instance roster has held two API versions for longer than `MIXED_VERSION_MINUTES` (default 15): a rolling deploy that stalled or a replica left behind. Roster entries carry `NIVARO_ROLE` (web or worker), so it reads "2 web, 1 worker".'
        ],
        [
          'Only this deployment runs scheduled jobs on its database',
          'Scheduled (not run-now) job runs from another instance landed in the last 24 hours, for example a laptop booted with `CRON_TICKS=on` against a shared database.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Every job run records the instance, process, how it was started (schedule, run now, chained, catch-up), whether its process had scheduled ticks on, and who held the scheduler lease. A scheduled run started by a process with ticks off raises one high-severity issue naming the job and the code path that started it. Shutting down or booting a process now only marks its own deployment’s running jobs as interrupted, never another instance’s.'
    },
    {
      type: 'h2',
      id: 'deploys-config-changes',
      text: 'Configuration changes on the incident timeline'
    },
    {
      type: 'p',
      text: 'Each burst of configuration writes appears once on the Ops Console incident timeline as `config:change`: the area (layout, pipeline, flow, schema, access, rules…), the tables, who saved it, the instance, and a link to the activity row of the save behind it. A latency shift or readiness drop can then be read against "layout 2 saved 20 minutes ago".'
    },
    { type: 'h2', id: 'deploys-dev-rows', text: 'Development traffic in the shared request log' },
    {
      type: 'p',
      text: 'When development machines share a database with a deployed instance, their requests would show as callers and failures there for 14 days. Request-log rows from `development` and `test` instances (and any named in `API_LOGS_DEV_INSTANCES`) are deleted after `API_LOGS_DEV_TTL_HOURS` (default 3, 0 = never). API Analytics shows deployed instances only by default; "Deployed instances" switches to all.'
    },
    {
      type: 'table',
      head: ['Setting', 'Default', 'What it changes'],
      rows: [
        ['`NIVARO_ROLE`', 'unset', 'web or worker; shown in the roster and the version check.'],
        [
          '`MIXED_VERSION_MINUTES`',
          '15',
          'How long two versions may run together before readiness warns.'
        ],
        [
          '`API_LOGS_DEV_INSTANCES`',
          'unset',
          'Extra instance names treated as development (comma list).'
        ],
        [
          '`API_LOGS_DEV_TTL_HOURS`',
          '3',
          'Hours development rows stay in the request log; 0 keeps them.'
        ]
      ]
    },
    { type: 'h2', id: 'deploys-early-hints', text: 'Early Hints (103) on the release image' },
    {
      type: 'p',
      text: 'The release image can answer a page load with a 103 Early Hints response before the page itself: it names the entry script and its preloaded chunks, the stylesheet, the font origins and any font the entry stylesheet loads, so the browser starts fetching them while the HTML is still on its way. The list is read from the built index.html when the API starts, so it always names the files of the running build. The same list rides the page response as a `Link` header, which a CDN in front can turn into its own 103.'
    },
    {
      type: 'table',
      head: ['EARLY_HINTS', 'What is sent'],
      rows: [
        [
          'unset / `off`',
          'Nothing (the default — whether a 103 passes through depends on the proxy in front).'
        ],
        ['`link`', 'Only the `Link` header on the page response.'],
        ['`on`', 'The 103 as well, to HTTP/1.1 and newer clients. HTTP/1.0 clients never get one.']
      ]
    },
    { type: 'h2', id: 'page-speed-prefetch', text: 'Prefetch on hover and intent' },
    {
      type: 'p',
      text: 'Resting the pointer on a list row or a record link fetches that record and the form layout it opens with, so the record page paints at once. Resting on a menu link (or tabbing to it) loads that screen’s code. While the browser is idle, a list also fetches its next page. A prefetched copy is at most a few seconds old and the page’s normal refresh replaces it. A tab makes at most 30 prefetch requests a minute, so sweeping the mouse down a long table never floods the API, and nothing is prefetched when the browser asks to save data.'
    }
  ]
}

export const instanceOverridesDocs: DocSection = {
  id: 'instance-overrides',
  label: 'Per-Instance Settings',
  content: [
    { type: 'h1', id: 'instance-overrides', text: 'Per-Instance Settings Overrides' },
    {
      type: 'p',
      text: 'When several environments share one database — a local machine and a staging server pointed at the same instance, for example — they also share the one settings row, which makes "use a local mail server in dev but keep the real relay on staging" impossible. Settings → This Instance solves that: each environment can overlay its own values on top of the shared settings, visible only to itself.'
    },
    { type: 'h3', text: 'How an instance is identified' },
    {
      type: 'p',
      text: 'Each API process resolves its instance key from the NIVARO_INSTANCE environment variable, falling back to NODE_ENV. That fallback means a local dev process ("development") and a deployed container ("production") already read different override sets with zero setup — set NIVARO_INSTANCE explicitly only when you run two environments that would otherwise share a NODE_ENV.'
    },
    { type: 'h3', text: 'What overrides apply to' },
    {
      type: 'ul',
      items: [
        'Overrides are read exactly where mail and SMS configuration is resolved — SMTP host/port/credentials/from, mail test mode and its allowlist, the environment label, and the SMS provider settings. Every other setting reads the shared row and is unaffected.',
        'The This Instance tab offers exactly those keys. Set a value to override it for this instance; leave a value blank to clear the shared value and fall back to this instance’s environment variables.',
        'A second layer exists for containers: the NIVARO_SETTINGS_OVERRIDES environment variable can hold a JSON object of the same keys, and it wins over anything set in the tab. It is read once at startup, so changing it requires a restart.',
        'Saving replaces this instance’s whole override set — the tab always shows and submits the complete list.'
      ]
    },
    {
      type: 'warn',
      text: 'The other Settings tabs (Email, SMS) keep showing and editing the shared row — deliberately, since that row serves every environment. So the Email tab can display SMTP values this particular instance is not actually using; check This Instance to see what is overlaid here.'
    },
    {
      type: 'note',
      text: 'Both the read (GET /api/settings/instance-overrides) and the save (PUT) are admin-only, and every save is audit-logged with the instance key and the keys it set.'
    }
  ]
}

export const mailHarnessDocs: DocSection = {
  id: 'mail-harness',
  label: 'Mail Templates & Test Harness',
  content: [
    { type: 'h1', id: 'mail-harness', text: 'Mail Templates & Test Harness' },
    {
      type: 'p',
      text: 'Every email the instance sends is registered as a mail TYPE (Mail Templates → "Send a real one"): what it is, which Liquid template renders it, and how to build it from a real sample — a workflow transition, a changed record, a user, a recent inbox row. Pick a type, pick a sample, and you see the exact email production would send, its subject, and the people it would go to with the reason each is on the list. Send it to yourself, to any address, or (admin, logged, confirmed) to the real recipients. Mail test mode still applies to every send.'
    },
    { type: 'h2', id: 'mail-harness-types', text: 'Registered types' },
    {
      type: 'table',
      head: ['Type', 'Template', 'Sample'],
      rows: [
        [
          'Workflow state change',
          'workflow_transition',
          'a workflow-history row — rendered THROUGH the delivering flow ("Workflows — notify owners" / "IR Approval — notify owners"), so subject and recipients are the flow\'s'
        ],
        ['Workflow canceled', 'workflow_canceled', 'a history row into a canceled state'],
        [
          'Record you watch changed',
          'record_watch',
          'a recent activity row (record card + labelled old → new table)'
        ],
        ['Collection subscription', 'subscription', 'a recent activity row'],
        [
          'Daily action summary',
          '(built in code)',
          'a user — the digest is built for them without flushing their deferred rows'
        ],
        [
          'Alert / Anomaly / SLA / Mention / Report / System / Workflow (generic)',
          'notification',
          'a recent inbox row of that category'
        ],
        [
          "Extension types (e.g. an extension's invoices-on-hold digest)",
          'invoice_on_hold',
          'registered by the extension through ctx.mail.registerType'
        ]
      ]
    },
    { type: 'h2', id: 'mail-harness-blocks', text: 'What the detailed templates carry' },
    {
      type: 'ul',
      items: [
        "Record card — the record's title (display template), a link, and the fields the collection's ACTIVE grouped layout pins in its item-header strip. The card follows the layout, not a per-collection field list in code.",
        'Approval path — every state in order: done (who, when), current (waiting on whom), upcoming (next owners). Cancel/reject branches only show once the record lands there.',
        'What changed — labelled old → new pairs since the record entered the state it just left (transition mails) or in this write (watch mails); FK ids resolve to display labels.',
        "The person's comment, only when a human wrote it — machine stamps (state merges, legacy syncs, imports) are never quoted back."
      ]
    },
    {
      type: 'note',
      text: "Flows keep owning WHEN an email goes out and to whom; a mail op's `template` option names the Liquid file that renders the body, with the full trigger payload (record_card, approval_chain, brief, actor_name…) as its context. Templates live in api/templates/mail (core) or <extension>/templates/mail; partials under partials/ are shared building blocks ({% render 'partials/record-card', card: record_card %}). The Templates tab edits any of them as a database override."
    },
    { type: 'h2', id: 'mail-harness-why', text: 'The "why me" footer' },
    {
      type: 'p',
      text: 'Every email ends with "You\'re getting this because …" and a link to the recipient\'s notification rules (in the app they use). The reason is per recipient: builders name it (assigned a task, approver for a step, watching a record, subscribed to a queue, delegate while someone is out), workflow transition mails read it off the trigger payload (owner of the new state, creator, additional contact), and anything without a stated reason falls back to the honest default — "your notification rules for <category> send you email".'
    },
    {
      type: 'ul',
      items: [
        "Flow mail ops: 'One email per recipient' (option `split`) sends each address its own copy — the footer and every link resolve for that person; 'Why-me line' (option `why`, templated) pins a shared reason for ops that mail one person per run.",
        "Programmatic senders pass `why` to notifyUser / sendMail / sendRawMail, or put `why` in the template's data.",
        'The rules link is the profile page — portal route key `profile` (Settings → Project → Frontend app), admin fallback /profile.'
      ]
    },
    { type: 'h2', id: 'mail-harness-branding', text: 'Mail branding per workspace' },
    {
      type: 'p',
      text: 'The chrome around every email — logo, accent colour, the "Sent by" name (also the From display name) and a footer line — can differ per workspace. Each workspace sets its own on the Workspaces page (Mail branding card); anything left blank keeps the instance branding from Settings → Project (project name, project colour), and with nothing set anywhere the stock chrome stands. A send resolves the workspace from an explicit `workspace_id` option, else the record it is about (its collection\'s workspace), else the recipient\'s current workspace. The From ADDRESS never changes — only its display name. The harness has a workspace picker beside the sample picker so every type can be previewed and sent as any workspace; the Workspaces page has a chrome-only preview of its own.'
    },
    { type: 'h2', id: 'notification-bench', text: 'Notification test bench' },
    {
      type: 'p',
      text: 'Data Tools → Notification Bench (admin). "Send me a sample of every category" delivers one real notification per category to you — through your own rules, so a category you switched off will not arrive, which is the point. The simulator takes a person + an event (category, subject, optional record, requested channels, "as of" time) and renders the exact delivery decision notifyUser would make: in-app, push, email (sent now / daily summary / off), SMS, with the reason for every kept or dropped channel (suspended, muted, matrix row, presence, quiet hours, digest mode, critical bypass, sender cadence), plus where the click lands in the portal and the admin and which inline action the row offers. Nothing is sent from the simulator.'
    },
    { type: 'h2', id: 'notification-targets', text: 'What a notification click does' },
    {
      type: 'p',
      text: "Every notification carries a structured target (record, task, approval, access request, SLA, chat room, queue, report, alerts, issue, import, dashboard, My Work) plus the action a click should offer. Each app maps the target onto ITS routes — the admin opens /collections/:c/:id or /tasks, the portal opens /records/:c/:id or My Work — and when a host has no page for the kind, it falls back to the server-resolved URL for the recipient's preferred app (same origin = in-app, foreign = new tab). Rows can carry an inline action the server declares safe to fire from a click: Mark task done, Acknowledge SLA. Rows written before targets existed are derived from collection + item + subject."
    },
    { type: 'h2', id: 'delegation-console', text: 'Delegation console' },
    {
      type: 'p',
      text: 'Monitoring → Delegation: one page for absence coverage. Stat strip (out now, out in the next N days, people covering, expiring, uncovered, approvals at risk), a red "would go unowned" section for anyone out — or entering an OOO window within 24 hours — with no working delegate (none, expired, suspended, or out themselves) and the open items in states they cover, the out-now and coming-up rosters, who covers whom, delegations ending soon (an expired one while the person is still out is flagged), the records blocked right now (admin; the coverage-gap resolver), and your own Out-of-office card. Admins assign or change a delegate for someone inline.'
    },
    {
      type: 'pre',
      code: `GET  /api/delegation/overview?days=14
POST /api/delegation/:userId/delegate   { delegate_id, delegate_expires_at?, is_out_of_office? }   # admin`
    },
    { type: 'h2', id: 'notification-templates', text: 'In-app notification templates' },
    {
      type: 'p',
      text: "Mail Templates → In-app notifications (admin). The wording of every templatable notification event — workflow state change, record created/updated/deleted (subscriptions and watches), mention in a record note, mention in chat, task assigned — edited as Liquid over the event's tokens: the first line renders the subject, the rest the message. The preview renders against a REAL recent example pulled from this database (the newest matching transition, activity row, mention, task), or a placeholder when none exists yet, so the admin sees what people actually receive. Saving stores an override (a `notification:<event>` row in the mail-template table, same revert lifecycle as email templates); a template that fails to render, or renders an empty subject, is refused rather than silently falling back."
    },
    {
      type: 'pre',
      code: `GET    /api/notification-templates            # events, tokens, override state
GET    /api/notification-templates/:key       # body (override or default) + real sample
POST   /api/notification-templates/:key/preview  { body?, data? } → { subject, message, context }
PUT    /api/notification-templates/:key       { body }
DELETE /api/notification-templates/:key       # revert`
    },
    { type: 'h2', id: 'notification-analytics', text: 'Notification analytics' },
    {
      type: 'p',
      text: 'Data Tools → Notification Analytics (admin). Over 7 / 30 / 90 days: notifications sent and read, the read rate and median time-to-read (read timestamps are stamped from this release on), a per-day series, and roll-ups by category, lane, kind, sender (people vs "System / automations") and collection — each with its own read rate and time-to-read — plus per-channel delivery outcomes (push sent vs no device, email sent / summary / off / failed) and the mute picture: how many people mute something, and which collections draw the most mutes against what they sent (the "stop telling me about this" rate).'
    },
    {
      type: 'p',
      text: 'Did it lead to action? A notification that points at a record counts as acted when its recipient moved that record, commented on it or finished a task on it within a window after it was sent (4, 24 or 72 hours; `?acted_hours=`). The Acted column shows that share per category, kind, lane and sender, and Read, ignored shows how many were opened and still got no action, so a category people read but never act on stands out. Notifications younger than the window are left out, and ones that do not point at a record (chat, dashboards, alerts) are not counted.'
    },
    { type: 'h2', id: 'broadcast-receipts', text: 'Broadcast receipts by audience' },
    {
      type: 'p',
      text: 'Broadcasts → history → "who saw this?" now opens with a per-audience roll-up: by role and by every scope dimension (zone, region…), delivered / opened (the inbox row was read — known for the in-app message channel) / acknowledged (banner dismissed) / still unread, with the unread names. "Nudge N unread" re-sends a "Reminder: …" inbox row (+ push through the normal rules) to exactly those people and records it as a `nudge` delivery; a second click skips anyone already nudged unless `again` is set. The in-app delivery of a broadcast keeps the inbox row id it produced (`notification_id` on the delivery receipt), which is what makes "opened" knowable.'
    },
    { type: 'h2', id: 'broadcast-draft', text: 'Draft a broadcast from bullets' },
    {
      type: 'p',
      text: 'Broadcasts → Message → "Draft from bullets": write a few points, one per line, and AI drafts the message for the chosen audience, severity and channels — a short banner line (≤200 characters), a fuller email with a subject (also used for the in-app message), and an SMS of at most 160 characters (always cut to fit, whatever the model returns). "Use" copies a draft into the composer; you edit and send as usual — nothing is sent or saved by drafting. Anyone who may send a broadcast may draft one (`POST /api/announcements/draft { bullets, audience, channels, severity }`, admin). The AI provider receives your points (with secret-looking values masked) and an audience description of role names, scope-dimension labels and counts — never a recipient’s name, email or phone, nor which zone values were picked. It runs on the per-feature "generate" model; each draft is logged as `broadcast-draft` activity.'
    },
    { type: 'h2', id: 'mail-delivery-board', text: 'Delivery board' },
    {
      type: 'p',
      text: 'Mail Log → Delivery rolls the outbound log up over the last 7 / 14 / 30 days: sent / failed / dropped / deferred with the success rate (sent ÷ attempted), a per-day stacked chart, a per-template table (labelled with the mail type when one template maps to exactly one type; a row opens the log filtered to it), the busiest recipients, "Not reaching" (addresses whose LATEST attempt failed), and failure reasons grouped by the stable head of the SMTP error (addresses, ids and session tokens collapsed). Raw sends log a template name too (flow ops as flow:<op key>, the digest as daily_digest); rows older than that land in "Untemplated sends".'
    },
    {
      type: 'p',
      text: 'A red banner at the top of the board means the RELAY is failing, not the addresses: the newest 20 send attempts are judged as one, and when at least 80% failed with one normalised error class the banner names it and when the streak began. Mixed failure classes are bounces and never raise it. The readiness check `mail-relay` makes the same judgement (skip under 8 attempts, pass, fail); `GET /api/mail-log/relay` returns it as JSON.'
    },
    { type: 'h2', id: 'mail-bounces', text: 'Bounced addresses' },
    {
      type: 'p',
      text: 'A hard bounce — the relay refused the ADDRESS (5xx on RCPT/DATA with the address rejected, a 550/551/553/554 head, or "user unknown" / "mailbox unavailable" / "no such user" / "does not exist" in the reply) — marks the address in `nivaro_mail_suppressions` (address, reason, first/last seen, count). From then on every sender drops it: each dropped address gets its own mail-log row with status dropped and error "suppressed: <reason>", and a send with nothing left returns dropped without touching the relay. Soft refusals (4xx, greylisting, a dead relay) never suppress. The first time an address is marked, every administrator is told once (system category), and so is the person\'s manager when the address belongs to a user; a repeat bounce never pages anyone again. The person\'s profile header and their contact card show a rose "Email bouncing · since <date>" pill; Mail Log → Suppressed addresses lists, searches and clears the marks (activity `mail-suppression-clear`), and the Delivery board counts them. `GET /api/mail-suppressions` (admin), `DELETE /api/mail-suppressions/:id` (admin), `GET /api/mail-suppressions/check?address=` (signed in).'
    },
    { type: 'h2', id: 'mail-harness-links', text: 'Where links land' },
    {
      type: 'p',
      text: 'Links in emails resolve per recipient. Settings → Project → "Frontend app (portal)" names the headless app and its routes (record, queue, report, alerts, chat, tasks, approvals, my_work, home; a `record:<collection>` key gives one collection its own page). A recipient\'s profile choice ("Email links open in": Automatic / Portal / Admin) wins; otherwise admins get the admin console and everyone else the portal. A destination the portal has no route for falls back to the admin. Emails sent to a list in one go (the workflow transition flows) link the portal when one is configured. Extensions can register the portal through ctx.links.register; the Settings value wins when both exist. The harness shows the app each recipient would land in.'
    },
    { type: 'h2', id: 'mail-harness-api', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/mail-types                      # every registered type
GET  /api/mail-types/:key/samples?q=      # real samples to pick from
POST /api/mail-types/:key/preview         # { sample_id } → { subject, html, recipients[] }
POST /api/mail-types/:key/send            # { sample_id, mode: 'self' | 'address' | 'recipients', to? }`
    }
  ]
}
