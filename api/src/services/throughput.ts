import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { selectInChunks } from './db-batch.js'

export interface ThroughputParams {
  collection: string
  from: Date
  to: Date
  /** Exclusive SQL upper bound: `to` advanced by one day when `to` was a date-only string, so the named day is fully included. Equals `to` otherwise. */
  toExclusive: Date
  bucket: 'day' | 'week' | 'month'
  user?: string
}

const BUCKETS = new Set(['day', 'week', 'month'])
const MAX_RANGE_DAYS = 730
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function parseThroughputParams(
  q: Record<string, unknown>
): { ok: true; params: ThroughputParams } | { ok: false; error: string } {
  const collection = typeof q.collection === 'string' ? q.collection.trim() : ''
  if (!collection) return { ok: false, error: 'collection is required' }
  const bucket = (q.bucket ?? 'week') as string
  if (!BUCKETS.has(bucket)) return { ok: false, error: `invalid bucket: ${bucket}` }
  const toStr = q.to ? String(q.to) : undefined
  const to = toStr ? new Date(toStr) : new Date()
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 90 * 86_400_000)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, error: 'from/to must be ISO dates' }
  }
  if (from > to) return { ok: false, error: 'from must be before to' }
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    return { ok: false, error: `date range capped at ${MAX_RANGE_DAYS} days` }
  }
  const toExclusive = toStr && DATE_ONLY.test(toStr) ? new Date(to.getTime() + 86_400_000) : to
  const user = typeof q.user === 'string' && q.user.trim() ? q.user.trim() : undefined
  return {
    ok: true,
    params: {
      collection,
      from,
      to,
      toExclusive,
      bucket: bucket as ThroughputParams['bucket'],
      user
    }
  }
}

export function bucketExpr(bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'day') return 'CONVERT(date, ts)'
  if (bucket === 'week') {
    return "DATEADD(day, -(DATEDIFF(day, '1900-01-01', ts) % 7), CONVERT(date, ts))"
  }
  return 'DATEFROMPARTS(YEAR(ts), MONTH(ts), 1)'
}

export interface ThroughputRow {
  user: string
  user_name: string
  bucket: string
  transitions: number
  completions: number
  send_backs: number
  avg_time_to_action_hours: number | null
}

export async function aggregateThroughput(params: ThroughputParams): Promise<{
  rows: ThroughputRow[]
  unattributed_transitions: number
}> {
  const expr = bucketExpr(params.bucket)
  const bind: any[] = [params.collection, params.from, params.toExclusive]
  let userFilter = ''
  if (params.user) {
    userFilter = 'AND usr = ?'
    bind.push(params.user)
  }
  const raw = await db.raw(
    `WITH hist AS (
       SELECT h.[user] AS usr, h.[timestamp] AS ts,
              LAG(h.[timestamp]) OVER (PARTITION BY h.instance ORDER BY h.[timestamp], h.id) AS prev_ts,
              sf.sort AS from_sort, st.sort AS to_sort,
              st.is_terminal AS to_terminal, st.[key] AS to_key
       FROM nivaro_workflow_history h
       JOIN nivaro_workflow_instances i ON i.id = h.instance AND i.collection = ?
       JOIN nivaro_workflow_states st ON st.id = h.to_state
       LEFT JOIN nivaro_workflow_states sf ON sf.id = h.from_state
     )
     SELECT usr, ${expr} AS bucket,
       COUNT(*) AS transitions,
       SUM(CASE WHEN to_terminal = 1 AND to_key <> 'canceled' THEN 1 ELSE 0 END) AS completions,
       SUM(CASE WHEN from_sort IS NOT NULL AND from_sort > to_sort THEN 1 ELSE 0 END) AS send_backs,
       AVG(CASE WHEN prev_ts IS NOT NULL THEN DATEDIFF(minute, prev_ts, ts) / 60.0 END) AS avg_hours
     FROM hist
     WHERE ts >= ? AND ts < ? AND usr IS NOT NULL ${userFilter}
     GROUP BY usr, ${expr}
     ORDER BY usr, bucket`,
    bind as any
  )
  const agg = rawRows<{
    usr: string
    bucket: Date | string
    transitions: number
    completions: number
    send_backs: number
    avg_hours: number | null
  }>(raw)

  const [unatt] = rawRows<{ n: number }>(
    await db.raw(
      `SELECT COUNT(*) AS n
       FROM nivaro_workflow_history h
       JOIN nivaro_workflow_instances i ON i.id = h.instance AND i.collection = ?
       WHERE h.[timestamp] >= ? AND h.[timestamp] < ? AND h.[user] IS NULL`,
      [params.collection, params.from, params.toExclusive]
    )
  )

  const userIds = [...new Set(agg.map((r) => String(r.usr)))]
  const users = userIds.length
    ? await selectInChunks(userIds, 2000, (chunk) =>
        db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
      )
    : []
  const nameById = new Map(
    (
      users as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string
      }>
    ).map((u) => [
      String(u.id).toUpperCase(),
      [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
    ])
  )

  const rows: ThroughputRow[] = agg.map((r) => ({
    user: String(r.usr),
    user_name: nameById.get(String(r.usr).toUpperCase()) ?? String(r.usr),
    bucket: (r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket)).slice(0, 10),
    transitions: Number(r.transitions),
    completions: Number(r.completions),
    send_backs: Number(r.send_backs),
    avg_time_to_action_hours: r.avg_hours == null ? null : Math.round(Number(r.avg_hours) * 10) / 10
  }))
  return { rows, unattributed_transitions: Number(unatt?.n ?? 0) }
}
