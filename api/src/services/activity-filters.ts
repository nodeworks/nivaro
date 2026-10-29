import type { Knex } from 'knex'
import { parseReportDate } from './activity-report.js'

/**
 * One filter shape for the audit log (#10/#11): GET /api/activity's params, the natural-language
 * search's output, a saved view's stored `filters` and a scheduled send all speak it, and all of
 * them reach the table through `applyActivityFilters` — the model never writes SQL.
 */
export interface ActivityFilters {
  user?: string | null
  actions?: string[]
  exclude_actions?: string[]
  collections?: string[]
  item?: string | null
  /** Absolute window (ISO or YYYY-MM-DD). A bare `to` date means the end of that day. */
  from?: string | null
  to?: string | null
  /** Relative window, resolved when the filters run (beats from/to). */
  range?: ActivityRange | null
  /** Plain text: entry comment, item id, action, collection or the person's name/email. */
  q?: string | null
}

export const ACTIVITY_RANGES = [
  'today',
  'yesterday',
  'last_24_hours',
  'last_7_days',
  'this_week',
  'last_week',
  'last_30_days',
  'this_month',
  'last_month',
  'last_90_days'
] as const
export type ActivityRange = (typeof ACTIVITY_RANGES)[number]

export const ACTION_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,49}$/
export const COLLECTION_RE = /^[A-Za-z0-9_]{1,64}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LIST = 50
const Q_MAX = 200
/** Text search with no window reads only this far back (a LIKE over 12M rows otherwise). */
export const TEXT_SEARCH_DEFAULT_DAYS = 90
const DAY_MS = 86_400_000

function list(v: unknown): string[] {
  if (v == null || v === '') return []
  const raw = Array.isArray(v) ? v : [v]
  const out: string[] = []
  for (const x of raw) {
    if (typeof x !== 'string' && typeof x !== 'number') continue
    for (const part of String(x).split(',')) {
      const s = part.trim()
      if (s) out.push(s)
    }
  }
  return [...new Set(out)].slice(0, MAX_LIST)
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

/**
 * Validate any filter-shaped input (query string, stored JSON, model output). Parts that do not
 * pass are dropped and named in `errors`; callers on a request answer 400 on errors, stored or
 * model input just loses the bad part.
 */
export function normalizeActivityFilters(raw: unknown): {
  filters: ActivityFilters
  errors: string[]
} {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: string[] = []
  const f: ActivityFilters = {}

  const user = text(src.user, 64)
  if (user) {
    if (UUID_RE.test(user)) f.user = user
    else errors.push('`user` must be a user id')
  }
  const pick = (keys: string[], re: RegExp, label: string) => {
    const vals = keys.flatMap((k) => list(src[k]))
    const ok = vals.filter((v) => re.test(v))
    if (ok.length < vals.length) errors.push(`\`${label}\` has an invalid value`)
    return [...new Set(ok)]
  }
  const actions = pick(['action', 'action[]', 'actions'], ACTION_RE, 'action')
  if (actions.length) f.actions = actions
  const excluded = pick(['exclude_actions', 'exclude_action'], ACTION_RE, 'exclude_actions')
  if (excluded.length) f.exclude_actions = excluded
  const collections = pick(
    ['collection', 'collection[]', 'collections'],
    COLLECTION_RE,
    'collection'
  )
  if (collections.length) f.collections = collections

  const item = text(src.item, 255)
  if (item) f.item = item
  const q = text(src.q, Q_MAX)
  if (q) f.q = q

  const range = text(src.range, 32)
  if (range) {
    if ((ACTIVITY_RANGES as readonly string[]).includes(range)) f.range = range as ActivityRange
    else errors.push('`range` is not a known range')
  }
  for (const edge of ['from', 'to'] as const) {
    const v = text(src[edge], 40)
    if (!v) continue
    const d = parseReportDate(v, edge === 'from' ? 'start' : 'end')
    if (d === 'invalid' || d == null) errors.push(`\`${edge}\` is not a valid date`)
    else f[edge] = v
  }
  return { filters: f, errors }
}

export function hasActivityFilter(f: ActivityFilters): boolean {
  return !!(
    f.user ||
    f.actions?.length ||
    f.exclude_actions?.length ||
    f.collections?.length ||
    f.item ||
    f.from ||
    f.to ||
    f.range ||
    f.q
  )
}

const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

/** A relative range as a UTC window (weeks start Monday). `to` null = up to now. */
export function resolveRange(
  range: ActivityRange,
  now = new Date()
): { from: Date; to: Date | null } {
  const today = startOfUtcDay(now)
  const dow = (today.getUTCDay() + 6) % 7 // Monday = 0
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  switch (range) {
    case 'today':
      return { from: today, to: null }
    case 'yesterday':
      return { from: new Date(today.getTime() - DAY_MS), to: new Date(today.getTime() - 1) }
    case 'last_24_hours':
      return { from: new Date(now.getTime() - DAY_MS), to: null }
    case 'last_7_days':
      return { from: new Date(now.getTime() - 7 * DAY_MS), to: null }
    case 'this_week':
      return { from: new Date(today.getTime() - dow * DAY_MS), to: null }
    case 'last_week': {
      const thisWeek = new Date(today.getTime() - dow * DAY_MS)
      return {
        from: new Date(thisWeek.getTime() - 7 * DAY_MS),
        to: new Date(thisWeek.getTime() - 1)
      }
    }
    case 'last_30_days':
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: null }
    case 'this_month':
      return { from: monthStart, to: null }
    case 'last_month': {
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      return { from: prev, to: new Date(monthStart.getTime() - 1) }
    }
    case 'last_90_days':
      return { from: new Date(now.getTime() - 90 * DAY_MS), to: null }
  }
}

/** The window the filters read, or null for no time bound. Text search is always bounded. */
export function activityWindow(
  f: ActivityFilters,
  now = new Date()
): { from: Date | null; to: Date | null; defaulted: boolean } {
  if (f.range) return { ...resolveRange(f.range, now), defaulted: false }
  const from = f.from ? parseReportDate(f.from, 'start') : null
  const to = f.to ? parseReportDate(f.to, 'end') : null
  const fromD = from instanceof Date ? from : null
  const toD = to instanceof Date ? to : null
  if (f.q && !fromD) {
    const anchor = toD ?? now
    return {
      from: new Date(anchor.getTime() - TEXT_SEARCH_DEFAULT_DAYS * DAY_MS),
      to: toD,
      defaulted: true
    }
  }
  return { from: fromD, to: toD, defaulted: false }
}

/** A LIKE pattern for user text: wildcards in the text match themselves. */
export function likeContains(value: string, mssql: boolean): string {
  const escaped = mssql ? value.replace(/[%_[]/g, '[$&]') : value.replace(/[%_\\]/g, '\\$&')
  return `%${escaped}%`
}

/**
 * Apply the filters to a query over `nivaro_activity as <alias>`. Every value is bound; nothing
 * the caller (or the model) wrote becomes SQL.
 */
export function applyActivityFilters<T extends Knex.QueryBuilder>(
  qb: T,
  f: ActivityFilters,
  opts: { alias?: string; mssql: boolean; now?: Date }
): T {
  const a = opts.alias ?? 'a'
  if (f.user) qb.where(`${a}.user`, f.user)
  if (f.actions?.length) qb.whereIn(`${a}.action`, f.actions)
  if (f.exclude_actions?.length) qb.whereNotIn(`${a}.action`, f.exclude_actions)
  if (f.collections?.length === 1) qb.where(`${a}.collection`, f.collections[0])
  else if (f.collections?.length) qb.whereIn(`${a}.collection`, f.collections)
  if (f.item) qb.where(`${a}.item`, f.item)
  const w = activityWindow(f, opts.now)
  if (w.from) qb.where(`${a}.timestamp`, '>=', w.from)
  if (w.to) qb.where(`${a}.timestamp`, '<=', w.to)
  if (f.q) {
    const pat = likeContains(f.q, opts.mssql)
    const q = f.q
    qb.where((inner) => {
      inner
        .where(`${a}.comment`, 'like', pat)
        .orWhere(`${a}.item`, q)
        .orWhere(`${a}.action`, 'like', pat)
        .orWhere(`${a}.collection`, 'like', pat)
        .orWhereIn(`${a}.user`, function users(this: Knex.QueryBuilder) {
          this.select('id')
            .from('nivaro_users')
            .where('email', 'like', pat)
            .orWhere('first_name', 'like', pat)
            .orWhere('last_name', 'like', pat)
        })
    })
  }
  return qb
}
