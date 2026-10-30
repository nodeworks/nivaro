import type { Knex } from 'knex'

/**
 * Activity report window + summary queries (admin Reports page, GET /api/reports/summary).
 *
 * nivaro_activity holds millions of rows (11.6M on EFP_Development) and has no index that
 * leads on timestamp. The summary used to aggregate the WHOLE table when no range was sent
 * and grouped by user AFTER joining nivaro_users (GROUP BY user + three name columns): 11 s
 * on dev, a 15 s timeout on staging (2026-10-23). Now the summary always has a window (the
 * last 30 days when the caller sends no `from`), every aggregate reads nivaro_activity alone,
 * and names are looked up for the grouped user ids afterwards.
 */

export const SUMMARY_DEFAULT_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A report date from a query string. A bare `YYYY-MM-DD` `to` means the END of that day (a
 * date picker's "to 2025-12-31" includes the 31st); `from` means its start. Anything else
 * goes through Date. Empty → null; unparseable → 'invalid'.
 */
export function parseReportDate(
  value: string | undefined,
  edge: 'start' | 'end'
): Date | null | 'invalid' {
  if (value == null || value.trim() === '') return null
  const v = value.trim()
  if (DATE_ONLY.test(v)) {
    const d = new Date(`${v}T00:00:00.000Z`)
    if (Number.isNaN(d.getTime())) return 'invalid'
    return edge === 'end' ? new Date(d.getTime() + DAY_MS - 1) : d
  }
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? 'invalid' : d
}

export interface ReportWindow {
  from: Date
  to: Date | null
  /** True when `from` was not sent and the default window applied. */
  defaulted: boolean
}

/**
 * The summary's window. `from` missing → SUMMARY_DEFAULT_DAYS before `to` (or before now):
 * an unbounded aggregate over the activity log never runs on a request.
 */
export function summaryWindow(
  q: { from?: string; to?: string },
  now: Date = new Date()
): ReportWindow | { error: string } {
  const from = parseReportDate(q.from, 'start')
  const to = parseReportDate(q.to, 'end')
  if (from === 'invalid') return { error: '`from` is not a valid date' }
  if (to === 'invalid') return { error: '`to` is not a valid date' }
  if (from) return { from, to, defaulted: false }
  const anchor = to ?? now
  return { from: new Date(anchor.getTime() - SUMMARY_DEFAULT_DAYS * DAY_MS), to, defaulted: true }
}

/**
 * The summary aggregates, each over nivaro_activity alone (no join). `apply` narrows every one
 * of them (the Audit report's filters); `groupKey` (migration 516's column exists) adds the
 * largest burst — the most rows one bulk action / import / flow run / job wrote.
 */
export function summaryQueries(
  k: Knex,
  win: Pick<ReportWindow, 'from' | 'to'>,
  opts: { apply?: (qb: Knex.QueryBuilder) => void; groupKey?: boolean } = {}
) {
  const base = () => {
    const b = k('nivaro_activity as a').where('a.timestamp', '>=', win.from)
    if (win.to) b.where('a.timestamp', '<=', win.to)
    opts.apply?.(b)
    return b
  }
  return {
    largestBurst: opts.groupKey
      ? base()
          .select('a.group_key')
          .min('a.action as action')
          .max('a.action as action_max')
          .min('a.collection as collection')
          .max('a.collection as collection_max')
          .count('a.id as count')
          .whereNotNull('a.group_key')
          .groupBy('a.group_key')
          .orderBy('count', 'desc')
          .limit(1)
      : null,
    byAction: base()
      .select('a.action')
      .count('a.id as count')
      .groupBy('a.action')
      .orderBy('count', 'desc'),
    byCollection: base()
      .select('a.collection')
      .count('a.id as count')
      .whereNotNull('a.collection')
      .groupBy('a.collection')
      .orderBy('count', 'desc'),
    byUser: base()
      .select('a.user as user_id')
      .count('a.id as count')
      .groupBy('a.user')
      .orderBy('count', 'desc'),
    total: base().count('a.id as count')
  }
}

export interface SummaryUserRow {
  user_id: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  count: number
}

/**
 * Grouped user counts + the names looked up for them, in count order. A user id with no
 * nivaro_users row (or the NULL "system" group) keeps null names, as the old LEFT JOIN did.
 * Ids are matched case-insensitively (mssql returns uniqueidentifiers upper-case).
 */
export function mergeUserNames(
  grouped: { user_id: string | null; count: string | number }[],
  users: { id: string; first_name: string | null; last_name: string | null; email: string | null }[]
): SummaryUserRow[] {
  const byId = new Map(users.map((u) => [String(u.id).toLowerCase(), u]))
  return grouped.map((r) => {
    const u = r.user_id == null ? undefined : byId.get(String(r.user_id).toLowerCase())
    return {
      user_id: r.user_id,
      first_name: u?.first_name ?? null,
      last_name: u?.last_name ?? null,
      email: u?.email ?? null,
      count: Number(r.count)
    }
  })
}

export interface LargestBurst {
  group_key: string
  count: number
  /** The one action / collection every row shares, else null (a mixed burst). */
  action: string | null
  collection: string | null
}

/** The largest-burst row → its answer; bursts of one are not bursts. */
export function largestBurstOf(rows: unknown[] | null | undefined): LargestBurst | null {
  const r = (rows?.[0] ?? null) as Record<string, unknown> | null
  if (!r) return null
  const count = Number(r.count)
  if (!Number.isFinite(count) || count < 2) return null
  const same = (a: unknown, b: unknown) => (a != null && a === b ? String(a) : null)
  return {
    group_key: String(r.group_key ?? ''),
    count,
    action: same(r.action, r.action_max),
    collection: same(r.collection, r.collection_max)
  }
}
