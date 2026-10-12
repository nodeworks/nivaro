import type { Knex } from 'knex'

/**
 * The one filter object over the API request log and the log ring (#1914).
 *
 * The request list (GET /api-analytics/requests), its "rank by" view, "Ask the
 * logs" and log alert rules built from a question (#1960) all compile through
 * here, so a question, the chips it shows, the list it opens and the alert it
 * saves can never mean different things.
 */

export type LogTarget = 'requests' | 'log'
export type LogGroup = 'caller' | 'path'

export interface LogFilter {
  /** requests = nivaro_api_logs (every replica); log = this replica's pino ring. */
  target: LogTarget
  /** Look-back when no `from` is given (1–720). */
  hours?: number
  /** Path contains. */
  path?: string
  method?: string
  /** '2xx' … '5xx' or one exact code. */
  status?: string
  /** Comma list of session | token | api_key | masquerade | none. */
  auth?: string
  /** Every caller that is not a person's browser session. */
  inbound?: boolean
  /** status >= 400. */
  errors?: boolean
  /** One person's account id. */
  user?: string
  /** Their name, for the chip (never used to filter). */
  user_label?: string
  api_key?: number
  /** ISO bounds. */
  from?: string
  to?: string
  /** log target: minimum level. */
  level?: 'info' | 'warn' | 'error'
  /** log target: text the line contains. */
  q?: string
  /** Rank callers or paths instead of listing requests. */
  group?: LogGroup
}

export const LOG_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export const LOG_AUTH = ['session', 'token', 'api_key', 'masquerade', 'none'] as const
export const LOG_LEVELS = ['info', 'warn', 'error'] as const
export const LOG_LEVEL_NUM: Record<string, number> = { info: 30, warn: 40, error: 50 }
const MAX_HOURS = 24 * 30
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * Request input (a saved rule, the client's edited chips) checked field by
 * field. Anything unknown or malformed is dropped, never passed on.
 */
export function cleanLogFilter(raw: unknown): LogFilter {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const f: LogFilter = { target: r.target === 'log' ? 'log' : 'requests' }
  const hours = Number(r.hours)
  if (Number.isFinite(hours) && hours > 0) f.hours = Math.min(MAX_HOURS, Math.ceil(hours))
  const from = isoOrNull(r.from)
  const to = isoOrNull(r.to)
  if (from) f.from = from
  if (to) f.to = to
  if (f.target === 'log') {
    if ((LOG_LEVELS as readonly string[]).includes(String(r.level)))
      f.level = r.level as LogFilter['level']
    if (typeof r.q === 'string' && r.q.trim()) f.q = r.q.trim().slice(0, 200)
    return f
  }
  if (typeof r.path === 'string' && r.path.trim()) f.path = r.path.trim().slice(0, 200)
  const method = String(r.method ?? '').toUpperCase()
  if ((LOG_METHODS as readonly string[]).includes(method)) f.method = method
  const status = String(r.status ?? '').toLowerCase()
  if (/^[1-5]xx$/.test(status) || /^[1-5]\d\d$/.test(status)) f.status = status
  if (r.inbound === true || r.inbound === 1 || r.inbound === '1' || r.inbound === 'true')
    f.inbound = true
  else if (typeof r.auth === 'string') {
    const kinds = r.auth
      .split(',')
      .map((v) => v.trim())
      .filter((v) => (LOG_AUTH as readonly string[]).includes(v))
    if (kinds.length) f.auth = [...new Set(kinds)].join(',')
  }
  if (r.errors === true || r.errors === 1 || r.errors === '1') f.errors = true
  if (typeof r.user === 'string' && UUID_RE.test(r.user)) {
    f.user = r.user.toUpperCase()
    if (typeof r.user_label === 'string' && r.user_label.trim())
      f.user_label = r.user_label.trim().slice(0, 120)
  }
  const key = Number(r.api_key)
  if (r.api_key != null && Number.isInteger(key) && key > 0) f.api_key = key
  if (r.group === 'caller' || r.group === 'path') f.group = r.group
  return f
}

/** The look-back start: `from` when given, else now − hours (default 24). */
export function filterSince(f: LogFilter, now = Date.now()): Date {
  if (f.from) return new Date(f.from)
  return new Date(now - (f.hours ?? 24) * 3_600_000)
}

/** LIKE-escape for SQL Server (brackets are its escape). */
export function likeContains(s: string): string {
  return `%${s.replace(/[%_[]/g, (m) => `[${m}]`)}%`
}

/**
 * The request-log WHERE clause, on a query whose log table is aliased `a`.
 * Time bounds included; the caller adds instance scope, ordering and paging.
 */
export function applyRequestFilters<T extends Knex.QueryBuilder>(
  qb: T,
  f: LogFilter,
  a = 'l',
  now = Date.now()
): T {
  void qb.where(`${a}.created_at`, '>=', filterSince(f, now))
  if (f.to) void qb.where(`${a}.created_at`, '<=', new Date(f.to))
  if (f.path) void qb.where(`${a}.path`, 'like', likeContains(f.path))
  if (f.method) void qb.where(`${a}.method`, f.method)
  if (f.status) {
    const m = /^([1-5])xx$/i.exec(f.status)
    if (m) {
      const lo = Number(m[1]) * 100
      void qb.where(`${a}.status`, '>=', lo).andWhere(`${a}.status`, '<', lo + 100)
    } else if (/^\d{3}$/.test(f.status)) void qb.where(`${a}.status`, Number(f.status))
  }
  if (f.user) void qb.where(`${a}.user`, f.user)
  if (f.api_key != null) void qb.where(`${a}.api_key_id`, f.api_key)
  if (f.inbound) void qb.whereIn(`${a}.auth`, ['token', 'api_key'])
  else if (f.auth) void qb.whereIn(`${a}.auth`, f.auth.split(','))
  if (f.errors) void qb.where(`${a}.status`, '>=', 400)
  return qb
}

/** One request row against a filter, in memory (suggestion coverage, tests). */
export function requestMatches(
  f: LogFilter,
  row: {
    method: string
    path: string
    status: number
    user?: string | null
    api_key_id?: number | null
    auth?: string | null
  }
): boolean {
  if (f.target !== 'requests') return false
  if (f.path && !row.path.toLowerCase().includes(f.path.toLowerCase())) return false
  if (f.method && row.method.toUpperCase() !== f.method) return false
  if (f.status) {
    const m = /^([1-5])xx$/i.exec(f.status)
    if (m) {
      if (Math.floor(row.status / 100) !== Number(m[1])) return false
    } else if (row.status !== Number(f.status)) return false
  }
  if (f.user && String(row.user ?? '').toUpperCase() !== f.user) return false
  if (f.api_key != null && row.api_key_id !== f.api_key) return false
  if (f.inbound && !['token', 'api_key'].includes(String(row.auth))) return false
  if (!f.inbound && f.auth && !f.auth.split(',').includes(String(row.auth))) return false
  if (f.errors && row.status < 400) return false
  return true
}

/** The query params the request list (and its shared component) takes. */
export function requestListParams(f: LogFilter): Record<string, string> {
  const p: Record<string, string> = {}
  if (f.hours) p.hours = String(f.hours)
  if (f.path) p.path = f.path
  if (f.method) p.method = f.method
  if (f.status) p.status = f.status
  if (f.user) p.user = f.user
  if (f.api_key != null) p.api_key = String(f.api_key)
  if (f.inbound) p.inbound = '1'
  else if (f.auth) p.auth = f.auth
  if (f.errors) p.errors = '1'
  if (f.from) p.from = f.from
  if (f.to) p.to = f.to
  if (f.group) p.group = f.group
  return p
}

/** What a filter says, as chips ("errors only", "5xx", "Beth Ng"). */
export function filterChips(f: LogFilter): Array<{ key: keyof LogFilter; label: string }> {
  const out: Array<{ key: keyof LogFilter; label: string }> = []
  out.push({ key: 'target', label: f.target === 'log' ? 'Server log' : 'API requests' })
  if (f.from || f.to) {
    out.push({
      key: 'from',
      label: `${f.from ? f.from.slice(0, 16).replace('T', ' ') : '…'} → ${f.to ? f.to.slice(0, 16).replace('T', ' ') : 'now'} UTC`
    })
  } else if (f.hours) out.push({ key: 'hours', label: `last ${f.hours}h` })
  if (f.level) out.push({ key: 'level', label: `${f.level} and above` })
  if (f.q) out.push({ key: 'q', label: `contains "${f.q}"` })
  if (f.user) out.push({ key: 'user', label: f.user_label ?? 'one person' })
  if (f.api_key != null) out.push({ key: 'api_key', label: `API key #${f.api_key}` })
  if (f.method) out.push({ key: 'method', label: f.method })
  if (f.path) out.push({ key: 'path', label: `path ~ ${f.path}` })
  if (f.status) out.push({ key: 'status', label: `status ${f.status}` })
  if (f.errors) out.push({ key: 'errors', label: 'errors only' })
  if (f.inbound) out.push({ key: 'inbound', label: 'integrations only' })
  else if (f.auth) out.push({ key: 'auth', label: `auth ${f.auth.replace(/,/g, ' / ')}` })
  if (f.group) out.push({ key: 'group', label: f.group === 'caller' ? 'top callers' : 'top paths' })
  return out
}
