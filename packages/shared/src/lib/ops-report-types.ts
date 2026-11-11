/**
 * Daily operations report — the API contract the shared page reads (#ops-report, 2026-11-10).
 * Twin of api/src/services/ops-report/types.ts: change both.
 *
 * Routes (administrators only):
 *   GET   /api/ops-reports?limit=60           → { data: OpsReportListRow[] }  newest first
 *   GET   /api/ops-reports/trends?days=90     → { data: OpsTrendPoint[] }     oldest first, one per day (latest run)
 *   GET   /api/ops-reports/:id                → { data: OpsReport }
 *   POST  /api/ops-reports/run {day?: 'YYYY-MM-DD'} → 202 { data: { id } } (runs in the background; poll GET /:id until status != 'running')
 *   GET   /api/ops-reports/:id/drill?metric=<OpsDrillMetric>&key=<optional row key>&limit=200
 *                                           → { data: OpsDrill } — the rows behind one number for
 *                                             that report's window (e.g. metric=server_errors, or
 *                                             metric=slow_route&key=POST /api/widgets-internal/:id/render)
 *   GET   /api/ops-reports/settings           → { data: OpsReportSettings }
 *   PATCH /api/ops-reports/settings           → { data: OpsReportSettings } (400 → { error, fields: { <setting>: message } })
 */

export type OpsVerdict = 'healthy' | 'watch' | 'bad'
export type OpsRunStatus = 'running' | 'ready' | 'digest_only' | 'failed'

/** Flat numbers per report: what trends and Compare chart. Every key is optional (older reports). */
export interface OpsKpis {
  active_people?: number
  signed_in_today?: number
  sign_ins?: number
  carried_sessions?: number
  new_accounts?: number
  view_as_sessions?: number
  requests?: number
  page_views?: number
  avg_ms?: number
  p95_ms?: number
  p99_ms?: number
  over5s?: number
  server_errors?: number
  client_errors?: number
  deadlocks?: number
  deploys?: number
  job_failures?: number
  integration_failures?: number
  integration_calls_failed?: number
  open_alarms?: number
  mail_sent?: number
  mail_failed?: number
  mail_deferred?: number
  moves?: number
  creates?: number
  searches?: number
  search_zero?: number
  backlog_waiting?: number
  trouble_people?: number
  new_places?: number
  failed_sign_ins?: number
  open_bugs?: number
  health_score?: number
  pages_viewed?: number
  browser_errors?: number
  support_opened?: number
  support_open?: number
  ai_calls?: number
  ai_cost_usd?: number
  data_violations?: number
  /** Extension sections add their own, namespaced `<section>.<key>` (e.g. `business.requested_usd`). */
  [key: string]: number | undefined
}

/** How each KPI reads: its label, unit and which way is good. */
export interface OpsKpiMeta {
  key: string
  label: string
  unit?: 'ms' | 'usd' | 'count' | 'pct'
  /** 'down' = lower is better (errors, p95); 'up' = higher is better; null = neutral (traffic). */
  better: 'up' | 'down' | null
  group:
    | 'people'
    | 'traffic'
    | 'speed'
    | 'errors'
    | 'integrations'
    | 'work'
    | 'security'
    | 'business'
}

export interface OpsReportListRow {
  id: number
  day: string
  status: OpsRunStatus
  verdict: OpsVerdict | null
  score: number | null
  headline: string | null
  trigger: 'cron' | 'manual'
  created_at: string
  finished_at: string | null
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  kpis: OpsKpis
}

export interface OpsTrendPoint {
  id: number
  day: string
  verdict: OpsVerdict | null
  score: number | null
  kpis: OpsKpis
}

export interface OpsDelta {
  key: string
  label: string
  unit?: OpsKpiMeta['unit']
  today: number
  prev: number | null
  week_avg: number | null
  /** today vs prev, percent (null when prev is 0 or missing). */
  change_pct: number | null
  /** true = moved the good way, false = the bad way, null = neutral or unchanged. */
  good: boolean | null
}

export interface OpsComparison {
  prev_day: string | null
  week_days: number
  deltas: OpsDelta[]
}

export interface OpsIncident {
  title: string
  when: string
  severity: 'high' | 'medium' | 'low'
  impact: string
  cause: string
  evidence: string
}

export type OpsBugKind = 'needs_dev' | 'data_fix' | 'partner' | 'config'

/** A bug the tracker follows from report to report (idea 1). */
export interface OpsTrackedBug {
  key: string
  title: string
  kind: OpsBugKind
  status: 'new' | 'open' | 'fixed' | 'came_back'
  first_seen: string
  last_seen: string
  days_seen: number
  today_count: number
  /** Version deployed after it was last seen, when it stopped (fixed). */
  fixed_in: string | null
  impact: string | null
}

/** Sonnet's write-up. Absent on a digest-only run (AI off or failed). */
export interface OpsAnalysis {
  verdict: OpsVerdict
  score: number
  headline: string
  summary_md: string
  incidents: OpsIncident[]
  people_to_contact: Array<{ person: string; why: string }>
  watch_tomorrow: string[]
}

/** An extension's section (idea 8 — e.g. EFP business volume). */
export interface OpsSection {
  key: string
  title: string
  rows: Array<{
    /** KPI id inside the section (`requested_usd`); the KPI is `<section key>.<row key>`. */
    key: string
    label: string
    value: number
    unit?: OpsKpiMeta['unit']
    week_avg?: number | null
    note?: string
    better?: 'up' | 'down' | null
  }>
}

export interface OpsReport extends OpsReportListRow {
  window: { day: string; start: string; end: string; tz: string; label: string }
  digest: OpsDigest
  analysis: OpsAnalysis | null
  tracker: OpsTrackedBug[]
  comparison: OpsComparison
  kpi_meta: OpsKpiMeta[]
  tools: Array<{ tool: string; ok: boolean }>
  error: string | null
}

/** The stored numbers (no AI). Every block may be empty on an instance that lacks its source. */
export interface OpsDigest {
  version: number
  window: { day: string; start: string; end: string; tz: string; label: string }
  people: {
    active: number
    signed_in_today: number
    sign_ins: number
    carried_sessions: number
    first_time: number
    view_as_sessions: number
    trouble: Array<{ person: string; errors: number; slow: number; blocked: number }>
    machine_callers: Array<{ name: string; requests: number; errors: number }>
    by_role: Array<{ role: string; people: number }>
    /** Plain sentences explaining active vs signed in vs carried — show them as written. */
    explain: string[]
  }
  traffic: {
    requests: number
    page_views: number
    peak: { hour: number; requests: number; people: number } | null
    by_hour: Array<{
      hour: number
      requests: number
      people: number
      e5: number
      e4: number
      avg_ms: number
      over5s: number
    }>
  }
  speed: {
    avg_ms: number
    p50: number | null
    p90: number | null
    p95: number | null
    p99: number | null
    over1s: number
    over5s: number
    over30s: number
    slow_routes: Array<{ route: string; n: number; avg_ms: number; max_ms: number; people: number }>
    heavy_routes: Array<{ route: string; total_s: number; n: number; avg_ms: number }>
    bursts: Array<{ at: string; route: string; n: number; people: number; max_ms: number }>
  }
  errors: {
    server: Array<{
      at: string
      route: string
      path: string
      status: number
      ms: number
      person: string | null
    }>
    server_total: number
    drain_503: number
    client_by_route: Array<{
      status: number
      route: string
      n: number
      people: number
      message: string
    }>
    signed_out_401: number
  }
  deploys: Array<{ at: string; version: string | null; release: string | null }>
  drains: Array<{ at: string; n: number }>
  database: {
    deadlocks: Array<{ issue: number; at: string; victim: string; other: string }>
    timeouts: Array<{ issue: number; title: string }>
    freezes: Array<{ issue: number; title: string }>
  }
  issues: {
    new: Array<{ id: number; source: string; severity: string; title: string; count: number }>
    repeating: Array<{ id: number; title: string; count: number }>
  }
  jobs: {
    runs: number
    failed: Array<{ job: string; at: string; status: string; error: string | null }>
    slowest: Array<{ job: string; n: number; max_ms: number; avg_ms: number }>
  }
  integrations: {
    submissions: Array<{ api: string; status: string; n: number }>
    failures: Array<{ at: string; api: string; collection: string; item: string; error: string }>
    calls: Array<{
      api: string
      n: number
      failed: number
      avg_ms: number
      max_ms: number
      week_avg_ms: number | null
    }>
    open_alarms: Array<{ api: string; kind: string; outcome: string; n: number }>
    alerts: Array<{ title: string; status: string; started: string; ended: string | null }>
  }
  imports: Array<{ definition: string; status: string; runs: number; rows: number }>
  mail: {
    by_status: Array<{ status: string; n: number }>
    reasons: Array<{ reason: string; n: number }>
  }
  notifications: Array<{ category: string; n: number; recipients: number; read: number }>
  work: {
    moves: number
    movers: number
    by_state: Array<{ state: string; n: number }>
    creates: Array<{ collection: string; n: number; people: number }>
    backlog: Array<{ state: string; waiting: number; oldest_days: number | null }>
    sla_breaches: Array<{ rule: string; collection: string; breached: number }>
  }
  search: {
    n: number
    people: number
    zero: number
    avg_ms: number
    missed: Array<{ query: string; n: number }>
  }
  config_changes: Array<{
    at: string
    who: string | null
    action: string
    collection: string
    item: string | null
  }>
  security: {
    new_places: number
    failed_sign_ins: number
    view_as: Array<{ who: string | null; at: string }>
    role_changes: Array<{ at: string; who: string | null; person: string | null }>
    api_key_use: Array<{ name: string; requests: number }>
    access_grants: number
    access_requests: number
    waiting_authorization: number
  }
  capacity: {
    pool: { main_max: number | null; background_max: number | null } | null
    backups: {
      last_full: string | null
      last_full_age_hours: number | null
      last_log: string | null
      last_log_age_hours: number | null
    } | null
    restarts: Array<{ at: string; what: string }>
    memory_mb: number | null
    disk: Array<{ path: string; free_pct: number; free_gb: number }>
  }
  watch: {
    jobs_next: Array<{ job: string; at: string; heavy: boolean }>
    pending_sends: Array<{ api: string; n: number; oldest: string | null }>
    expiring: Array<{
      what: 'api_key' | 'certificate' | 'secret'
      name: string
      expires: string
      days: number
    }>
  }
  sections: OpsSection[]
  /** Screens people opened (page views), against the 7-day average. */
  pages: {
    views: number
    people: number
    top: Array<{
      page: string
      views: number
      people: number
      avg_seconds: number | null
      week_avg_views: number | null
    }>
  }
  /** Errors raised in people's browsers (client issues), grouped. */
  client_errors: Array<{
    id: number
    title: string
    count: number
    screen: string | null
    first_today: boolean
  }>
  /** Feature adoption: routes used today that were unused the 7 days before, and the fastest risers. */
  adoption: {
    new_routes: Array<{ route: string; n: number; people: number }>
    rising: Array<{ route: string; today: number; week_avg: number }>
  }
  support: {
    opened: number
    closed: number
    open_total: number
    oldest_open_days: number | null
    topics: Array<{ topic: string; n: number }>
    opened_today: Array<{ title: string; status: string }>
  }
  ai: {
    calls: number
    cost_usd: number
    errors: number
    refusals: number
    thumbs_up: number
    thumbs_down: number
    by_feature: Array<{ feature: string; calls: number; cost_usd: number; errors: number }>
  }
  /** Data-quality sweeps that finished in the window, with the previous run's count. */
  data_quality: Array<{
    collection: string
    violations: number
    prev: number | null
    checked: number
  }>
  /** Who has the most items waiting on them (latest queue owner snapshot). */
  owners: Array<{ person: string; waiting: number; sla_breached: number; at_risk: number }>
  /** Leads worked out before the AI starts (plain SQL): for each burst, deadlock, server error
   *  and partner-refusal cluster, what else happened at that minute, and what the data model
   *  says about a missing column. Timing is a lead, not proof. */
  leads?: Array<{ what: string; at: string; context: string; hint?: string | null }>
  /** The day's health score, computed from the numbers (no AI), with what took points off. */
  score: { value: number; parts: Array<{ label: string; points: number }> }
}

export const OPS_KPI_META: OpsKpiMeta[] = [
  { key: 'active_people', label: 'Active people', unit: 'count', better: null, group: 'people' },
  {
    key: 'signed_in_today',
    label: 'Signed in today (Microsoft)',
    unit: 'count',
    better: null,
    group: 'people'
  },
  {
    key: 'carried_sessions',
    label: 'Still signed in from earlier',
    unit: 'count',
    better: null,
    group: 'people'
  },
  { key: 'new_accounts', label: 'New accounts', unit: 'count', better: null, group: 'people' },
  {
    key: 'trouble_people',
    label: 'People who hit trouble',
    unit: 'count',
    better: 'down',
    group: 'people'
  },
  { key: 'requests', label: 'Requests', unit: 'count', better: null, group: 'traffic' },
  { key: 'page_views', label: 'Page views', unit: 'count', better: null, group: 'traffic' },
  { key: 'p95_ms', label: 'p95 response', unit: 'ms', better: 'down', group: 'speed' },
  { key: 'p99_ms', label: 'p99 response', unit: 'ms', better: 'down', group: 'speed' },
  { key: 'over5s', label: 'Requests over 5 s', unit: 'count', better: 'down', group: 'speed' },
  {
    key: 'server_errors',
    label: 'Server errors (500s)',
    unit: 'count',
    better: 'down',
    group: 'errors'
  },
  {
    key: 'client_errors',
    label: 'Refused requests (4xx)',
    unit: 'count',
    better: 'down',
    group: 'errors'
  },
  { key: 'deadlocks', label: 'Database deadlocks', unit: 'count', better: 'down', group: 'errors' },
  { key: 'job_failures', label: 'Failed jobs', unit: 'count', better: 'down', group: 'errors' },
  { key: 'deploys', label: 'Deploys', unit: 'count', better: null, group: 'traffic' },
  {
    key: 'integration_failures',
    label: 'Partner sends failed',
    unit: 'count',
    better: 'down',
    group: 'integrations'
  },
  {
    key: 'integration_calls_failed',
    label: 'Partner calls failed',
    unit: 'count',
    better: 'down',
    group: 'integrations'
  },
  {
    key: 'open_alarms',
    label: 'Open integration alarms',
    unit: 'count',
    better: 'down',
    group: 'integrations'
  },
  {
    key: 'mail_failed',
    label: 'Mail failed',
    unit: 'count',
    better: 'down',
    group: 'integrations'
  },
  { key: 'moves', label: 'Workflow moves', unit: 'count', better: 'up', group: 'work' },
  { key: 'creates', label: 'Records created', unit: 'count', better: 'up', group: 'work' },
  { key: 'backlog_waiting', label: 'Items waiting', unit: 'count', better: 'down', group: 'work' },
  {
    key: 'search_zero',
    label: 'Searches with no result',
    unit: 'count',
    better: 'down',
    group: 'work'
  },
  {
    key: 'new_places',
    label: 'Sign-ins from new places',
    unit: 'count',
    better: null,
    group: 'security'
  },
  {
    key: 'failed_sign_ins',
    label: 'Failed sign-ins',
    unit: 'count',
    better: 'down',
    group: 'security'
  },
  {
    key: 'open_bugs',
    label: 'Open bugs (tracker)',
    unit: 'count',
    better: 'down',
    group: 'errors'
  },
  { key: 'health_score', label: 'Health score', unit: 'count', better: 'up', group: 'errors' },
  { key: 'pages_viewed', label: 'Pages viewed', unit: 'count', better: null, group: 'traffic' },
  {
    key: 'browser_errors',
    label: 'Browser errors',
    unit: 'count',
    better: 'down',
    group: 'errors'
  },
  {
    key: 'support_opened',
    label: 'Support tickets opened',
    unit: 'count',
    better: 'down',
    group: 'work'
  },
  {
    key: 'support_open',
    label: 'Support tickets open',
    unit: 'count',
    better: 'down',
    group: 'work'
  },
  { key: 'ai_calls', label: 'AI calls', unit: 'count', better: null, group: 'traffic' },
  { key: 'ai_cost_usd', label: 'AI spend', unit: 'usd', better: 'down', group: 'traffic' },
  {
    key: 'data_violations',
    label: 'Data-quality problems',
    unit: 'count',
    better: 'down',
    group: 'work'
  }
]

/** Every number on the page can be drilled into; `key` narrows to one row of a list (a route,
 *  a partner, a state, a person, a job, a collection). */
export type OpsDrillMetric =
  | 'active_people'
  | 'signed_in_today'
  | 'carried_sessions'
  | 'new_accounts'
  | 'view_as_sessions'
  | 'machine_callers'
  | 'trouble_people'
  | 'requests'
  | 'requests_by_hour'
  | 'page_views'
  | 'over5s'
  | 'slow_route'
  | 'burst'
  | 'server_errors'
  | 'client_errors'
  | 'deploys'
  | 'deadlocks'
  | 'issues'
  | 'job_failures'
  | 'job'
  | 'integration_failures'
  | 'integration_calls'
  | 'open_alarms'
  | 'imports'
  | 'mail'
  | 'notifications'
  | 'moves'
  | 'creates'
  | 'backlog'
  | 'sla_breaches'
  | 'searches'
  | 'search_zero'
  | 'config_changes'
  | 'new_places'
  | 'failed_sign_ins'
  | 'role_changes'
  | 'api_key_use'
  | 'browser_errors'
  | 'adoption'
  | 'support'
  | 'ai_calls'
  | 'data_quality'
  | 'owners'
  | 'section'
  | 'latency'
  | 'score'
  | 'capacity'
  | 'access'
  | 'pending_sends'
  | 'expiring'
  | 'bugs'
  // Leaf levels — one thing, every detail (drill as far as the data goes):
  | 'request'
  | 'person'
  | 'issue'
  | 'job_run'
  | 'submission'
  | 'outbound_call'
  | 'mail_message'
  | 'login'

export interface OpsDrillColumn {
  key: string
  label: string
  type?: 'text' | 'number' | 'ms' | 'usd' | 'time' | 'status'
}

export interface OpsDrill {
  metric: OpsDrillMetric
  key: string | null
  title: string
  /** One plain sentence on what these rows are. */
  description: string
  columns: OpsDrillColumn[]
  /** Cells by column key. Optional per row:
   *   `_drill_metric` + `_drill_key` — the next level down (open it in the same panel, with a
   *     back step: a route → its requests → one request; a person → their day → one request);
   *   `_record_collection` + `_record_id` — the row IS a record: open it in the shared record
   *     drawer (DrilldownContext), which has its own "Open full record" — never navigate away;
   *   `_link` — an app path to the real thing (issue, job run, user, ticket); offered as an
   *     "Open" action inside the drawer, not followed on row click. */
  rows: Array<Record<string, string | number | null>>
  total: number
  truncated: boolean
  /** Leaf levels (`request`, `issue`, `job_run`, `submission`, `outbound_call`, `mail_message`,
   *  `login`, `person`): the one thing's fields and long text blocks (error body, stack, payload,
   *  response, deadlock statements). Rows may still list related items (a person's requests). */
  detail?: {
    fields: Array<{ label: string; value: string | number | null; link?: string | null }>
    blocks: Array<{ title: string; text: string; kind?: 'code' | 'json' | 'text' }>
  }
}

export interface OpsReportSettings {
  enabled: boolean
  window_start_hour: number
  window_end_hour: number
  model: string | null
  token_cap: number
  /** Master switch: the report may be emailed at all. Each administrator still opts in. */
  email: boolean
  notify: boolean
  /** GET only: the caller opted in to the email. Change it with
   *  PATCH /api/users/me/preferences { ops_report_email: true | null }. */
  email_me?: boolean
}
