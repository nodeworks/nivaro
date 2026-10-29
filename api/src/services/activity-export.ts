import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { type ActivityFilters, applyActivityFilters } from './activity-filters.js'

/**
 * Activity rows for exports, scheduled audit views and the person page's "What they did" tab
 * (#11/#13): the filtered rows newest first with the person's name, a CSV of them, and a
 * day → collection grouping.
 */

export interface ActivityExportRow {
  id: number
  action: string
  user: string | null
  timestamp: string
  collection: string | null
  item: string | null
  comment: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
}

export const EXPORT_ROW_CAP = 10_000

const iso = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v ?? ''))
  return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toISOString()
}

/** The matching rows, newest first, at most `limit` (+1 read to tell whether there were more). */
export async function fetchActivityRows(
  filters: ActivityFilters,
  opts: { limit?: number; now?: Date } = {}
): Promise<{ rows: ActivityExportRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(1, opts.limit ?? EXPORT_ROW_CAP), EXPORT_ROW_CAP)
  const q = db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'a.user', 'u.id')
    .select(
      'a.id',
      'a.action',
      'a.user',
      'a.timestamp',
      'a.collection',
      'a.item',
      'a.comment',
      'u.first_name',
      'u.last_name',
      'u.email as user_email'
    )
    .orderBy([
      { column: 'a.timestamp', order: 'desc' },
      { column: 'a.id', order: 'desc' }
    ])
    .limit(limit + 1)
  applyActivityFilters(q, filters, { mssql: isMssql(db), now: opts.now })
  const raw = (await q) as ActivityExportRow[]
  const rows = raw.slice(0, limit).map((r) => ({ ...r, timestamp: iso(r.timestamp) }))
  return { rows, truncated: raw.length > limit }
}

export function personName(r: ActivityExportRow): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
  return n || r.user_email || (r.user ? String(r.user).slice(0, 8) : '')
}

/** One CSV cell: quoted when needed; a leading formula character is neutralised. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function activityCsv(rows: ActivityExportRow[]): string {
  const header = ['Time (UTC)', 'Person', 'Email', 'Action', 'Collection', 'Item', 'Detail']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [
        iso(r.timestamp),
        personName(r),
        r.user_email ?? '',
        r.action,
        r.collection ?? '',
        r.item ?? '',
        r.comment ?? ''
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

/** The calendar day (YYYY-MM-DD) of a timestamp in a time zone. */
export function dayIn(ts: string | Date, tz: string): string {
  const d = ts instanceof Date ? ts : new Date(ts)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export interface DayGroup {
  day: string
  total: number
  collections: Array<{ collection: string | null; count: number; actions: Record<string, number> }>
}

/** Rows → days (newest first) → collections (busiest first) with per-action counts. */
export function groupActivityByDay(
  rows: Array<Pick<ActivityExportRow, 'timestamp' | 'collection' | 'action'>>,
  tz = 'UTC'
): DayGroup[] {
  const zone = safeTimeZone(tz)
  const days = new Map<string, Map<string, { count: number; actions: Record<string, number> }>>()
  for (const r of rows) {
    const day = dayIn(r.timestamp, zone)
    let cols = days.get(day)
    if (!cols) {
      cols = new Map()
      days.set(day, cols)
    }
    const key = r.collection ?? ''
    let c = cols.get(key)
    if (!c) {
      c = { count: 0, actions: {} }
      cols.set(key, c)
    }
    c.count++
    c.actions[r.action] = (c.actions[r.action] ?? 0) + 1
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, cols]) => {
      const collections = [...cols.entries()]
        .map(([collection, v]) => ({ collection: collection || null, ...v }))
        .sort(
          (a, b) => b.count - a.count || String(a.collection).localeCompare(String(b.collection))
        )
      return { day, total: collections.reduce((n, c) => n + c.count, 0), collections }
    })
}
