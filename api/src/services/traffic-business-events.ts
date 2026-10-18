// api/src/services/traffic-business-events.ts
/**
 * #2189 — the Business events lane: what the business did, per minute, beside what the API did.
 * Counts only, never values: records created (and which collections), workflow transitions,
 * approval decisions, imports finished, partner pushes accepted. Read from the tables that
 * already record each event (nivaro_activity, nivaro_workflow_history, nivaro_approval_decisions,
 * nivaro_import_jobs, nivaro_erp_submissions) while an admin has the lens open, cached for a few
 * seconds, so a quiet map costs nothing.
 */
import { db } from '../db/index.js'
import { tapState } from './traffic-taps.js'

export const BUSINESS_TAP = 'business-events'
export const MAX_MINUTES = 120
export const DEFAULT_MINUTES = 30
/** Rows read per source: a busy minute cannot make one poll unbounded. */
const ROW_CAP = 20_000
const CACHE_MS = 15_000
const COLLECTION_CAP = 6

export const BUSINESS_SERIES = [
  { key: 'created', label: 'Records created' },
  { key: 'transitions', label: 'Transitions' },
  { key: 'approvals', label: 'Approvals decided' },
  { key: 'imports', label: 'Imports finished' },
  { key: 'pushes', label: 'Partner pushes accepted' }
] as const
export type BusinessKey = (typeof BUSINESS_SERIES)[number]['key']

export interface BusinessSeries {
  key: BusinessKey
  label: string
  /** Per-minute counts, oldest first; the last point is the minute in progress. */
  points: number[]
  total: number
  /** The source table was missing or unreadable. */
  unavailable?: boolean
  /** The row cap cut the read short (the oldest minutes are undercounted). */
  truncated?: boolean
}
export interface BusinessEvents {
  /** Epoch ms of the first minute's start. */
  from: number
  minutes: number
  series: BusinessSeries[]
  /** Collections with the most creates in the window. */
  collections: Array<{ collection: string; created: number }>
}

export const minutesOf = (raw: unknown): number => {
  const n = Math.floor(Number(raw ?? DEFAULT_MINUTES))
  return Number.isFinite(n) ? Math.min(MAX_MINUTES, Math.max(5, n)) : DEFAULT_MINUTES
}

/** Pure: drop timestamps into `minutes` one-minute buckets starting at `from`. */
export function bucketMinutes(
  times: Array<Date | string>,
  from: number,
  minutes: number
): number[] {
  const out = new Array<number>(minutes).fill(0)
  for (const t of times) {
    const ms = new Date(t).getTime()
    if (!Number.isFinite(ms)) continue
    const i = Math.floor((ms - from) / 60_000)
    if (i >= 0 && i < minutes) out[i]++
  }
  return out
}

/** Pure: creates per collection, system tables left out, busiest first. */
export function topCreated(
  rows: Array<{ collection: string | null }>,
  cap = COLLECTION_CAP
): Array<{ collection: string; created: number }> {
  const by = new Map<string, number>()
  for (const r of rows) {
    const c = r.collection
    if (!c || c.startsWith('nivaro_') || c.startsWith('directus_')) continue
    by.set(c, (by.get(c) ?? 0) + 1)
  }
  return [...by]
    .map(([collection, created]) => ({ collection, created }))
    .sort((a, b) => b.created - a.created || a.collection.localeCompare(b.collection))
    .slice(0, cap)
}

interface Source {
  key: BusinessKey
  table: string
  time: string
  /** Extra filters on the table. */
  filter?: (q: ReturnType<typeof db>) => unknown
  extra?: string[]
}
const SOURCES: Source[] = [
  {
    key: 'created',
    table: 'nivaro_activity',
    time: 'timestamp',
    extra: ['collection'],
    filter: (q) => q.where('action', 'create')
  },
  { key: 'transitions', table: 'nivaro_workflow_history', time: 'timestamp' },
  { key: 'approvals', table: 'nivaro_approval_decisions', time: 'decided_at' },
  {
    key: 'imports',
    table: 'nivaro_import_jobs',
    time: 'completed_at',
    filter: (q) => q.whereIn('status', ['completed', 'complete', 'done', 'finished'])
  },
  {
    key: 'pushes',
    table: 'nivaro_erp_submissions',
    time: 'updated_at',
    filter: (q) => q.where('status', 'accepted')
  }
]

interface Cache {
  at: number
  minutes: number
  from: number
  value: BusinessEvents
}
const state = () => tapState<{ cache: Cache | null }>(BUSINESS_TAP, () => ({ cache: null }))

async function readSource(
  src: Source,
  since: Date
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean } | null> {
  try {
    if (!(await db.schema.hasTable(src.table))) return null
    const q = db(src.table).where(src.time, '>=', since)
    src.filter?.(q as never)
    const rows = (await q
      .orderBy(src.time, 'desc')
      .limit(ROW_CAP)
      .select(src.time, ...(src.extra ?? []))) as Array<Record<string, unknown>>
    return { rows, truncated: rows.length >= ROW_CAP }
  } catch {
    return null
  }
}

/** The last `minutes` minutes of business activity (cached ~15 s per minute count). */
export async function businessEvents(minutes: number, now = Date.now()): Promise<BusinessEvents> {
  const st = state()
  const hit = st.cache
  if (hit && hit.minutes === minutes && now - hit.at < CACHE_MS) return hit.value
  // the minute in progress is the last bucket
  const from = Math.floor(now / 60_000) * 60_000 - (minutes - 1) * 60_000
  const since = new Date(from)
  const series: BusinessSeries[] = []
  let collections: BusinessEvents['collections'] = []
  const reads = await Promise.all(SOURCES.map((s) => readSource(s, since)))
  SOURCES.forEach((src, i) => {
    const label = BUSINESS_SERIES.find((b) => b.key === src.key)?.label ?? src.key
    const r = reads[i]
    if (!r) {
      series.push({
        key: src.key,
        label,
        points: new Array<number>(minutes).fill(0),
        total: 0,
        unavailable: true
      })
      return
    }
    const points = bucketMinutes(
      r.rows.map((x) => x[src.time] as Date),
      from,
      minutes
    )
    if (src.key === 'created')
      collections = topCreated(
        r.rows.map((x) => ({ collection: (x.collection as string) ?? null }))
      )
    series.push({
      key: src.key,
      label,
      points,
      total: points.reduce((a, b) => a + b, 0),
      ...(r.truncated ? { truncated: true } : {})
    })
  })
  const value: BusinessEvents = { from, minutes, series, collections }
  st.cache = { at: now, minutes, from, value }
  return value
}
