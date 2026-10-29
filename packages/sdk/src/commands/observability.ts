/**
 * Observability commands: the audit log beyond the list (one entry, the action list, export
 * reporting), the change feed, background job runs (live log, cancel, what is busy), the
 * caller's own jobs and background reads, the API request log, per-key usage, the outbound
 * mail log and the caller's own notification delivery history.
 *
 * Admin-only reads say so; everything else is scoped to the caller by the API.
 */
import { type Command, cmd } from '../command.js'
import type { ActivityEntry, ISODate, UUID } from '../index.js'

// ─── Activity (audit log) ─────────────────────────────────────────────────────

/** One audit-log entry with its user agent and agent badge (admin). */
export function readActivityEntry(id: number): Command<{ data: ActivityEntry }> {
  return cmd('GET', `/activity/${id}`)
}

/** Every action name the audit log holds, sorted (admin) — for an action filter. */
export function listActivityActions(): Command<{ data: string[] }> {
  return cmd('GET', '/activity/actions')
}

/**
 * Record a client-side export (CSV / xlsx / PDF made in the browser) in the audit log as an
 * `export` entry for the caller. Any signed-in person may report their own export.
 */
export function logExport(body: {
  collection: string
  row_count?: number
  /** csv | xlsx | pdf … (first 10 characters kept). */
  format?: string
  /** The filters the export ran with (first 300 characters of their JSON kept). */
  filters?: unknown
}): Command<{ data: { logged: true } }> {
  return cmd('POST', '/activity/export-log', undefined, body)
}

/**
 * Write an audit entry by hand. Administrators only in practice: a non-admin may write only
 * the actions the server lists as client-writable (none today). `action` is 1–50 of
 * letters, digits and `- _ : .`.
 */
export function createActivityEntry(body: {
  action: string
  collection?: string
  item?: string | number
  comment?: string
}): Command<{ ok: true }> {
  return cmd('POST', '/activity', undefined, body)
}

// ─── Change feed ──────────────────────────────────────────────────────────────

/** One record change in the feed — ids, actions and field NAMES only, never values. */
export interface FeedChange {
  collection: string
  id: string
  /** A record created and changed within one page reads `create`. */
  action: 'create' | 'update' | 'delete'
  /** Updates: the readable fields that changed; absent when unknown. */
  fields?: string[]
  at: ISODate
}

export interface FeedPage {
  changes: FeedChange[]
  /** Pass back as `cursor` for the next page. */
  cursor: string
  /** More changes are already waiting: call again at once. */
  has_more: boolean
  /** Named collections the caller cannot read (or that do not exist). */
  not_readable?: string[]
  notes?: string[]
}

/**
 * The change feed for clients without a live socket (`GET /changes`): records the caller
 * can see now that were created, changed or deleted since a cursor or a time. Without
 * `cursor` or `since` the feed starts from now (an empty page with a cursor). Refusals
 * carry a `code` (e.g. a cursor this feed did not issue).
 *
 *   let page = (await nivaro.request(readChanges({ since: '2026-10-29T12:00:00Z' }))).data
 *   while (page.has_more) page = (await nivaro.request(readChanges({ cursor: page.cursor }))).data
 */
export function readChanges(query?: {
  cursor?: string
  /** ISO time to start from (ignored with a cursor). */
  since?: string
  /** Up to 50 collection names; default every collection the caller may read. */
  collections?: string[]
  /** Changes per page (default 100, max 500). */
  limit?: number
}): Command<{ data: FeedPage }> {
  const params: Record<string, unknown> = {}
  if (query?.cursor) params.cursor = query.cursor
  if (query?.since) params.since = query.since
  if (query?.collections?.length) params.collections = query.collections.join(',')
  if (query?.limit != null) params.limit = query.limit
  return cmd('GET', '/changes', params)
}

// ─── Background job runs (admin) ──────────────────────────────────────────────

export interface JobLogLine {
  seq: number
  at: ISODate
  level: 'info' | 'warn' | 'error' | (string & {})
  line: string
}

/**
 * A run's live log: the lines written so far (`after` = the last `seq` you already have),
 * plus its status, progress and first error line (admin).
 */
export function readJobRunLog(
  id: number,
  after?: number
): Command<{
  data: {
    run: {
      id: number
      status: string
      progress: string | null
      outcome: string | null
      error: string | null
    }
    lines: JobLogLine[]
  }
}> {
  return cmd('GET', `/job-runs/${id}/log`, after ? { after } : undefined)
}

/**
 * Ask a running job to stop (admin). Cooperative: cancel-aware loops stop at their next
 * chunk; the flag is per process, so a run on another replica may finish anyway.
 */
export function cancelJobRun(id: number): Command<{ data: { cancel_requested: true } }> {
  return cmd('POST', `/job-runs/${id}/cancel`)
}

export interface BusyJob {
  /** The job run id; -1 for an import in flight. */
  id: number
  kind: string
  label: string
  started_at: ISODate
  elapsed_ms: number
  /** Median of the same job's recent runs; null without history. */
  expected_ms: number | null
  remaining_ms: number | null
  overrun: boolean
}

/** What heavy work is running right now — heavy crons, backfills, exports, imports (admin). */
export function readBusyJobs(): Command<{
  data: { busy: boolean; items: BusyJob[]; heavy_slot: unknown }
}> {
  return cmd('GET', '/job-runs/busy')
}

// ─── The caller's own jobs ────────────────────────────────────────────────────

/** One entry of the caller's jobs tray (a job run or a staged import they queued). */
export interface MyJob {
  key: string
  kind: string
  label?: string | null
  status: 'queued' | 'running' | 'completed' | 'error' | 'canceled'
  progress?: Record<string, unknown> | null
  outcome?: string | null
  error?: string | null
  /** App path to the details page or the finished file. */
  href?: string | null
  /** A file the job produced. */
  file_id?: string | null
  /** API path (under /api) to POST to cancel the running job. */
  cancel_path?: string | null
  /** Import queue: 1 = next up. */
  position?: number | null
  eta_seconds?: number | null
  at: ISODate
}

/** What the caller started that is running or finished in the last 30 minutes. */
export function listMyJobs(): Command<{ data: MyJob[] }> {
  return cmd('GET', '/my-jobs')
}

// ─── Background reads (slow reads handed to the server) ───────────────────────

export interface BackgroundRun {
  id: string
  kind: 'custom-query' | 'widget' | 'report-widget' | 'dashboard-widget' | (string & {})
  subject: string
  label: string
  href: string | null
  method: 'GET' | 'POST'
  url: string
  status: 'running' | 'completed' | 'error'
  started_at: ISODate
  finished_at: ISODate | null
  /** Typical duration when the run started (progress = elapsed / expected). */
  expected_ms: number | null
  http_status: number | null
  error: string | null
  /** False when the answer was too big to keep: ask the route again. */
  result_kept: boolean
}

/** How long a replayable read usually takes and whether it counts as slow. */
export function estimateBackgroundRun(
  method: 'GET' | 'POST',
  url: string
): Command<{
  data: { typical_ms: number | null; runs: number; slow: boolean; threshold_ms: number }
}> {
  return cmd('GET', '/background-runs/estimate', { method, url })
}

/**
 * Hand a slow read to the server (a custom query execute or a widget read). It is replayed
 * AS the caller; the same question asked twice joins the first run (`joined: true`).
 */
export function startBackgroundRun(body: {
  method: 'GET' | 'POST'
  /** The API path of the read, e.g. `/api/custom-queries/q/execute`. */
  url: string
  body?: unknown
  label?: string
  /** App-relative link back to the page. */
  href?: string
}): Command<{ data: BackgroundRun & { joined: boolean } }> {
  return cmd('POST', '/background-runs', undefined, body)
}

/** The caller's background reads, newest first. */
export function listBackgroundRuns(): Command<{ data: BackgroundRun[] }> {
  return cmd('GET', '/background-runs')
}

/** One of the caller's background reads (404 for anyone else's). */
export function readBackgroundRun(id: string): Command<{ data: BackgroundRun }> {
  return cmd('GET', `/background-runs/${id}`)
}

/**
 * The finished answer, exactly as the route gave it. 409 BACKGROUND_RUN_RUNNING while it
 * runs, 422 when it failed, 410 RESULT_GONE once no longer kept.
 */
export function readBackgroundRunResult<T = unknown>(id: string): Command<T> {
  return cmd('GET', `/background-runs/${id}/result`)
}

// ─── API request log (admin) ──────────────────────────────────────────────────

export interface ApiRequestLogEntry {
  id: number
  method: string
  path: string
  status: number
  latency_ms: number
  user: UUID | null
  user_name: string | null
  user_email: string | null
  collection: string | null
  api_key_id: number | null
  api_key_name: string | null
  /** session | token | api_key | masquerade | none */
  auth: string | null
  ip: string | null
  user_agent: string | null
  error: string | null
  request_body: string | null
  query: string | null
  created_at: ISODate
}

export interface ApiRequestLogQuery {
  /** Look-back window (default 24). */
  hours?: number
  /** ISO bounds; `from` beats `hours`. */
  from?: string
  to?: string
  /** Contains-match on the path. */
  path?: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Exact (`404`) or a class (`4xx`, `5xx`). */
  status?: string
  /** Errors only (status ≥ 400). */
  errors?: boolean
  /** A user id. */
  user?: UUID
  /** A named API key id. */
  api_key?: number
  /** Comma list of session | token | api_key | masquerade | none. */
  auth?: string
  /** Every caller that is not a person's browser session (token + API key). */
  inbound?: boolean
  /** Rank instead of list: the top 20 callers or paths. */
  group?: 'caller' | 'path'
  page?: number
  /** Rows per page (default 50, max 200). */
  limit?: number
  /** Include development instances' rows. */
  all_instances?: boolean
}

/**
 * The per-request API log behind the analytics (admin). With `group` the answer ranks
 * callers or paths in `groups` and `data` is empty.
 */
export function listApiRequests(query?: ApiRequestLogQuery): Command<{
  data: ApiRequestLogEntry[]
  total: number
  page?: number
  limit?: number
  groups?: Array<Record<string, unknown>>
}> {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === '' || v === false) continue
    if (k === 'all_instances') params.instances = 'all'
    else params[k] = v === true ? 1 : v
  }
  return cmd('GET', '/api-analytics/requests', params)
}

export interface ApiKeyTraffic {
  api_key_id: number
  name: string
  count: number
  avg_latency: number
  errors: number
  last_seen: ISODate | null
}

/** Traffic per named API key over the window (admin; session traffic excluded). */
export function readApiAnalyticsByKey(hours?: number): Command<{ data: ApiKeyTraffic[] }> {
  return cmd('GET', '/api-analytics/by-key', hours != null ? { hours } : undefined)
}

// ─── API key usage (admin) ────────────────────────────────────────────────────

export interface ApiKeyUsage {
  key: { id: number; name: string; is_active: boolean }
  window_days: number
  total: number
  errors: number
  last_seen: ISODate | null
  /** One entry per day of the window, gaps as zero. */
  days: Array<{ day: string; count: number; errors: number }>
  top_routes: Array<{
    method: string
    path: string
    count: number
    avg_latency: number
    errors: number
  }>
}

/** A key's last 30 days: daily calls and errors, top routes (admin). */
export function readApiKeyUsage(id: number): Command<{ data: ApiKeyUsage }> {
  return cmd('GET', `/api-keys/${id}/usage`)
}

export interface ApiKeyUsageBucket {
  calls: number
  errors: number
  rate_limited: number
  avg_ms: number | null
}

export interface ApiKeyMonthlyUsage {
  key: { id: number; name: string; prefix: string | null }
  month: string
  window: { start: ISODate; end: ISODate }
  retention: { days: number; oldest_log: ISODate | null; partial: boolean; note: string | null }
  totals: ApiKeyUsageBucket & {
    error_rate: number
    refused: number
    reads_ok: number
    writes_ok: number
  }
  by_day: Array<ApiKeyUsageBucket & { day: string }>
  by_family: Array<ApiKeyUsageBucket & { family: string }>
  graphql: Array<{ operation: string; kind: string | null; calls: number; errors: number }>
  egress: { reads_ok: number; note: string }
}

/**
 * A key's usage statement for one calendar month (`YYYY-MM`, admin). `format: 'csv'`
 * answers the statement as CSV text.
 */
export function readApiKeyMonthlyUsage(
  id: number,
  month: string,
  format?: 'json'
): Command<{ data: ApiKeyMonthlyUsage }>
export function readApiKeyMonthlyUsage(id: number, month: string, format: 'csv'): Command<string>
export function readApiKeyMonthlyUsage(
  id: number,
  month: string,
  format?: 'json' | 'csv'
): Command<{ data: ApiKeyMonthlyUsage } | string> {
  return cmd('GET', `/api-keys/${id}/usage`, format === 'csv' ? { month, format } : { month })
}

// ─── Outbound mail log ────────────────────────────────────────────────────────

export interface MailLogEntry {
  id: number
  /** Comma list of recipients. */
  to: string
  subject: string | null
  template: string | null
  status: 'sent' | 'failed' | 'dropped' | 'deferred' | (string & {})
  error: string | null
  created_at: ISODate
}

/** Every send attempt with its outcome, newest first, 50 a page (admin). */
export function listMailLog(query?: {
  status?: 'sent' | 'failed' | 'dropped' | 'deferred'
  /** A template key; `(untemplated)` = sends without one. */
  template?: string
  /** Contains-match on recipient or subject. */
  search?: string
  page?: number
}): Command<{ data: MailLogEntry[]; total: number; page: number }> {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params[k] = v
  return cmd('GET', '/mail-log', params)
}

/** One send with its stored body (admin). */
export function readMailLogEntry(
  id: number
): Command<{ data: MailLogEntry & { body?: string | null } & Record<string, unknown> }> {
  return cmd('GET', `/mail-log/${id}`)
}

/** Send a logged mail again from its stored body (admin; test mode applies). 502 on failure. */
export function resendMail(id: number): Command<{ data: { resent: true } }> {
  return cmd('POST', `/mail-log/${id}/resend`)
}

/** The delivery board: the window rolled up per day, template and recipient (admin). */
export function readMailStats(days?: 7 | 14 | 30): Command<{ data: Record<string, unknown> }> {
  return cmd('GET', '/mail-log/stats', days ? { days } : undefined)
}

/**
 * The mail sent about one record (headers only, never bodies, newest 50) — for anyone who
 * can read the record.
 */
export function listRecordMail(
  collection: string,
  item: string | number
): Command<{ data: MailLogEntry[] }> {
  return cmd('GET', `/mail-log/record/${collection}/${item}`)
}

// ─── The caller's notification delivery history ───────────────────────────────

export interface NotificationHistoryEntry {
  kind: 'notification' | 'metric_alert' | 'record_alert' | 'report_alert' | 'digest_email'
  at: ISODate
  title: string
  detail: string | null
  collection?: string | null
  item?: string | null
  status?: string | null
  /** How it reached the caller: 'in-app' | 'push' | 'email' | 'digest email'. */
  channels?: string[]
}

/**
 * What actually reached the caller, newest first: in-app notifications, alert firings for
 * rules they subscribe to, report alerts they created and digest-queued emails.
 */
export function readNotificationHistory(
  limit?: number
): Command<{ data: NotificationHistoryEntry[] }> {
  return cmd('GET', '/users/me/notification-history', limit != null ? { limit } : undefined)
}
