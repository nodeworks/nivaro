import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * #2758 — cumulative flow diagram: how many records sat in each pipeline
 * state at the end of every day, stacked into bands. Widening bands show where
 * work piles up; the gap between arrivals and done is the lead time.
 *
 * Built from nivaro_workflow_history alone: every row opens a stay in
 * `to_state` that the instance's next row closes, so each stay is a +1 on its
 * entry day and a -1 on its exit day. Stays that began before the window fold
 * into a baseline, then a running sum gives each day's end-of-day count.
 *
 * Computed AS THE VIEWER: only records the viewer may read count (read
 * permission, role row filter, User Scopes, widget filters). A nightly cron
 * also stores an unrestricted year of daily counts per template/collection in
 * Redis; a viewer with no row filter and no scope restriction reads long
 * ranges from it instead of the history table.
 */

export const CFD_MAX_DAYS = 730
export const CFD_ROLLUP_DAYS = 365
/** Ranges longer than this are served from the nightly rollup when allowed. */
export const CFD_LIVE_MAX_DAYS = 90
const ROLLUP_TTL_S = 36 * 3600
const DAY_MS = 86_400_000

export interface CfdState {
  id: string
  key: string
  label: string
  color: string | null
  sort: number
  is_terminal: boolean
}

export interface CfdDay {
  day: string
  /** state id -> records in that state at the end of the day */
  counts: Record<string, number>
  total: number
}

export interface CumulativeFlow {
  template: string
  collection: string | null
  from: string
  to: string
  states: CfdState[]
  days: CfdDay[]
  summary: {
    /** records that entered the pipeline during the range */
    arrivals: number
    /** records that reached a terminal state during the range */
    done: number
    avg_wip: number
    /** Little's law: average work in progress over throughput per day; null when nothing finished. */
    lead_time_days: number | null
  }
  source: 'live' | 'rollup'
}

export interface CfdDelta {
  state: string
  /** YYYY-MM-DD, or null for everything before the range */
  day: string | null
  delta: number
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

export function enumerateDays(from: Date, to: Date): string[] {
  const out: string[] = []
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  for (let t = start; t <= end; t += DAY_MS) out.push(isoDay(new Date(t)))
  return out
}

/** Pure: baseline + per-day deltas -> end-of-day counts per state. */
export function foldDeltas(deltas: CfdDelta[], days: string[], states: CfdState[]): CfdDay[] {
  const running = new Map<string, number>()
  const byDay = new Map<string, Map<string, number>>()
  for (const d of deltas) {
    if (d.day == null) running.set(d.state, (running.get(d.state) ?? 0) + d.delta)
    else {
      const m = byDay.get(d.day) ?? new Map<string, number>()
      m.set(d.state, (m.get(d.state) ?? 0) + d.delta)
      byDay.set(d.day, m)
    }
  }
  const out: CfdDay[] = []
  for (const day of days) {
    for (const [st, n] of byDay.get(day) ?? []) running.set(st, (running.get(st) ?? 0) + n)
    const counts: Record<string, number> = {}
    let total = 0
    for (const s of states) {
      const n = Math.max(0, running.get(s.id) ?? 0)
      counts[s.id] = n
      total += n
    }
    out.push({ day, counts, total })
  }
  return out
}

/** Pure: summary figures from the folded days. Arrivals = growth of the total
 *  plus what left the pipeline is not modelled (records never leave), so the
 *  total's growth IS the arrivals. */
export function summarize(days: CfdDay[], states: CfdState[]): CumulativeFlow['summary'] {
  if (days.length === 0) return { arrivals: 0, done: 0, avg_wip: 0, lead_time_days: null }
  const terminal = states.filter((s) => s.is_terminal).map((s) => s.id)
  const doneAt = (d: CfdDay) => terminal.reduce((a, id) => a + (d.counts[id] ?? 0), 0)
  const first = days[0]
  const last = days[days.length - 1]
  const arrivals = Math.max(0, last.total - first.total)
  const done = Math.max(0, doneAt(last) - doneAt(first))
  const wip = days.map((d) => d.total - doneAt(d))
  const avg = wip.reduce((a, b) => a + b, 0) / wip.length
  const perDay = done / Math.max(1, days.length - 1)
  return {
    arrivals,
    done,
    avg_wip: Math.round(avg * 10) / 10,
    lead_time_days: perDay > 0 ? Math.round((avg / perDay) * 10) / 10 : null
  }
}

export interface CfdParams {
  template: string
  collection?: string | null
  from: Date
  to: Date
  /** conditions the record must meet (widget filters), already vetted by the caller */
  conditions?: Array<{ field: string; op?: string; value: unknown }>
}

export function parseCfdParams(
  q: Record<string, unknown>
): { ok: true; params: CfdParams } | { ok: false; error: string } {
  const template = typeof q.template === 'string' ? q.template.trim() : ''
  if (!/^[0-9A-Za-z-]{8,64}$/.test(template)) return { ok: false, error: 'template is required' }
  const collection =
    typeof q.collection === 'string' && q.collection.trim() ? q.collection.trim() : null
  if (collection && (!/^[A-Za-z0-9_]+$/.test(collection) || /^nivaro_/i.test(collection)))
    return { ok: false, error: 'Invalid collection' }
  const to = q.to ? new Date(String(q.to)) : new Date()
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 90 * DAY_MS)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    return { ok: false, error: 'from/to must be ISO dates' }
  if (from > to) return { ok: false, error: 'from must be before to' }
  if ((to.getTime() - from.getTime()) / DAY_MS > CFD_MAX_DAYS)
    return { ok: false, error: `date range capped at ${CFD_MAX_DAYS} days` }
  return { ok: true, params: { template, collection, from, to } }
}

async function loadStates(template: string): Promise<CfdState[]> {
  const rows = (await db('nivaro_workflow_states')
    .where({ template })
    .orderBy('sort')
    .select('id', 'key', 'label', 'color', 'sort', 'is_terminal')) as Array<{
    id: string
    key: string
    label: string
    color: string | null
    sort: number
    is_terminal: boolean | number
  }>
  return rows.map((r) => ({ ...r, id: String(r.id), is_terminal: !!r.is_terminal }))
}

/** Delta rows for one template + collection. `restrictIds` narrows the records
 *  (a viewer's readable set as a subquery); null = every record. */
async function loadDeltas(
  template: string,
  collection: string,
  from: Date,
  toExclusive: Date,
  restrict: ((q: import('knex').Knex.QueryBuilder) => void) | null
): Promise<CfdDelta[]> {
  const inner = db('nivaro_workflow_history as h')
    .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .where('i.template', template)
    .where('i.collection', collection)
    .select(
      'h.to_state as st',
      'h.timestamp as ts',
      db.raw(
        'LEAD(h.[timestamp]) OVER (PARTITION BY h.instance ORDER BY h.[timestamp], h.id) AS nxt'
      )
    )
  if (restrict) restrict(inner)
  const dayExpr = 'CASE WHEN t < ? THEN NULL ELSE CONVERT(varchar(10), CONVERT(date, t), 23) END'
  const rows = (await db
    .with('h', inner)
    .with(
      'ev',
      db.raw(
        'SELECT st, ts AS t, 1 AS d FROM h UNION ALL SELECT st, nxt, -1 FROM h WHERE nxt IS NOT NULL'
      )
    )
    .from('ev')
    .select('st as state')
    .select(db.raw(`${dayExpr} AS day`, [from]))
    .sum({ delta: 'd' })
    .where('t', '<', toExclusive)
    .groupBy('st')
    .groupByRaw(dayExpr, [from])) as unknown as Array<{
    state: string
    day: string | null
    delta: number
  }>
  return rows.map((r) => ({
    state: String(r.state),
    day: r.day ?? null,
    delta: Number(r.delta)
  }))
}

/** Collections that hold instances of the template. */
async function templateCollections(template: string): Promise<string[]> {
  const rows = (await db('nivaro_workflow_instances')
    .where({ template })
    .distinct('collection')) as Array<{ collection: string }>
  return rows.map((r) => r.collection).filter((c) => c && !/^nivaro_/i.test(c))
}

function mergeDeltas(parts: CfdDelta[][]): CfdDelta[] {
  const m = new Map<string, CfdDelta>()
  for (const list of parts)
    for (const d of list) {
      const k = `${d.state}|${d.day ?? ''}`
      const cur = m.get(k)
      if (cur) cur.delta += d.delta
      else m.set(k, { ...d })
    }
  return [...m.values()]
}

function assemble(
  params: CfdParams,
  states: CfdState[],
  deltas: CfdDelta[],
  source: 'live' | 'rollup'
): CumulativeFlow {
  const days = enumerateDays(params.from, params.to)
  const folded = foldDeltas(deltas, days, states)
  return {
    template: params.template,
    collection: params.collection ?? null,
    from: days[0] ?? isoDay(params.from),
    to: days[days.length - 1] ?? isoDay(params.to),
    states,
    days: folded,
    summary: summarize(folded, states),
    source
  }
}

const rollupKey = (template: string, collection: string) => `nvr:cfd:v1:${template}:${collection}`
const inCloud = () => !!process.env.CLOUD_META_DB_URL

/** Viewer is unrestricted on the collection: no row filter, no scope. */
async function viewerUnrestricted(user: User, collection: string): Promise<boolean> {
  const { getRowFilter } = await import('./permissions.js')
  const { getUserScopeEnforcement } = await import('./user-scopes.js')
  if (await getRowFilter(user, 'read', collection)) return false
  const scope = await getUserScopeEnforcement(user, collection)
  return scope.filters.length === 0 && !scope.deny
}

export async function getCumulativeFlow(
  user: User,
  params: CfdParams,
  redis?: Redis | null
): Promise<{ data: CumulativeFlow } | { error: string; status: number }> {
  const states = await loadStates(params.template)
  if (states.length === 0) return { error: 'Template has no states', status: 404 }
  const { can } = await import('./permissions.js')
  const all = await templateCollections(params.template)
  const collections = params.collection ? all.filter((c) => c === params.collection) : all

  const toExclusive = new Date(
    Date.UTC(params.to.getUTCFullYear(), params.to.getUTCMonth(), params.to.getUTCDate() + 1)
  )
  const fromStart = new Date(
    Date.UTC(params.from.getUTCFullYear(), params.from.getUTCMonth(), params.from.getUTCDate())
  )
  const spanDays = (params.to.getTime() - params.from.getTime()) / DAY_MS
  const parts: CfdDelta[][] = []
  let usedRollup = false
  for (const collection of collections) {
    if (!(await can(user, 'read', collection).catch(() => false))) continue
    const filtered = (params.conditions?.length ?? 0) > 0
    const unrestricted = !filtered && (await viewerUnrestricted(user, collection))

    // Long ranges for an unrestricted viewer: the nightly rollup
    if (unrestricted && spanDays > CFD_LIVE_MAX_DAYS && redis && !inCloud()) {
      const hit = await redis.get(rollupKey(params.template, collection)).catch(() => null)
      if (hit) {
        try {
          const stored = JSON.parse(hit) as { from: string; deltas: CfdDelta[] }
          if (new Date(`${stored.from}T00:00:00Z`) <= params.from) {
            // the rollup stores deltas against its own start: re-base on ours
            parts.push(rebase(stored.deltas, isoDay(params.from)))
            usedRollup = true
            continue
          }
        } catch {
          /* fall through to the live read */
        }
      }
    }

    const restrict = unrestricted ? null : await viewerRestriction(user, collection, params)
    parts.push(await loadDeltas(params.template, collection, fromStart, toExclusive, restrict))
  }
  return { data: assemble(params, states, mergeDeltas(parts), usedRollup ? 'rollup' : 'live') }
}

/** Fold a rollup's deltas (dated from its own start) into a later start: days
 *  before `from` collapse into the null baseline. */
export function rebase(deltas: CfdDelta[], from: string): CfdDelta[] {
  return deltas.map((d) => (d.day == null || d.day < from ? { ...d, day: null } : d))
}

/** The viewer's readable records as a subquery on the history join. */
async function viewerRestriction(
  user: User,
  collection: string,
  params: CfdParams
): Promise<(q: import('knex').Knex.QueryBuilder) => void> {
  const { applyRowFilter, getRowFilter } = await import('./permissions.js')
  const { applyUserScopesToQuery } = await import('./user-scopes.js')
  const ids = db(collection).select(db.raw('CAST(id AS NVARCHAR(255))'))
  const rowFilter = await getRowFilter(user, 'read', collection)
  if (rowFilter) applyRowFilter(ids, rowFilter, user)
  await applyUserScopesToQuery(ids, collection, user)
  for (const c of params.conditions ?? []) applyCondition(ids, c)
  return (q) => {
    q.whereIn(db.raw('CAST(i.item AS NVARCHAR(255))') as never, ids as never)
  }
}

function applyCondition(
  q: import('knex').Knex.QueryBuilder,
  c: { field: string; op?: string; value: unknown }
) {
  const op = c.op ?? 'eq'
  if (op === 'eq') {
    if (c.value === null) q.whereNull(c.field)
    else q.where(c.field, c.value as string)
  } else if (op === 'neq') {
    if (c.value === null) q.whereNotNull(c.field)
    else q.whereNot(c.field, c.value as string)
  } else if (op === 'in') {
    const list = Array.isArray(c.value) ? c.value : String(c.value ?? '').split(',')
    q.whereIn(c.field, list as string[])
  }
}

/** Nightly: store an unrestricted year of deltas per template + collection. */
export async function runCfdRollup(redis: Redis | null | undefined): Promise<{ stored: number }> {
  if (!redis || inCloud()) return { stored: 0 }
  const to = new Date()
  const back = new Date(to.getTime() - CFD_ROLLUP_DAYS * DAY_MS)
  const from = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth(), back.getUTCDate()))
  const toExclusive = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1))
  const templates = (await db('nivaro_workflow_instances').distinct('template')) as Array<{
    template: string
  }>
  let stored = 0
  for (const { template } of templates) {
    if (!template) continue
    for (const collection of await templateCollections(String(template))) {
      const deltas = await loadDeltas(String(template), collection, from, toExclusive, null)
      await redis.setex(
        rollupKey(String(template), collection),
        ROLLUP_TTL_S,
        JSON.stringify({ from: isoDay(from), deltas })
      )
      stored++
    }
  }
  return { stored }
}
