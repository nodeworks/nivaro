// api/src/services/traffic-history-reads.ts
/**
 * Traffic Map — the database reads behind the long-history features (the pure figures are in
 * traffic-history-analysis.ts). Every read is bounded (a window cap, TOP N / a row cap) and binds
 * every value: long statements go through runLongSql as knex-built SQL with escaped literals
 * (`toQuery()`, timestamps passed as UTC ISO strings — a JS Date would be rendered in local time).
 *
 *  - logSteps         — the request log per step and node (hourly aggregates for the time-lapse
 *                       when the minute store is off, #2183)
 *  - peopleSteps      — people online (concurrency samples) and people active (distinct users in
 *                       the request log) per step (#2249)
 *  - searchHistory    — last hit / first error / busiest hour (#2175)
 *  - routeRows        — one route's logged requests in a window (#2193 / #2252)
 *  - jobInputs        — the cron roster + recent scheduled runs (#2165)
 *  - timelapseMarkers — deploys, restarts, config writes, maintenance and incidents in a range
 */
import type { Knex } from 'knex'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { extensionRoutes } from '../extensions/loader.js'
import { hasColumn } from '../lib/column-probe.js'
import { devInstanceKeys } from './api-log-instances.js'
import { runLongSql } from './run-long.js'
import { LOCAL_LOG_DAYS, STORE_MAX_DAYS, storeEnabled } from './telemetry-store.js'
import {
  callerKeyFor,
  classifyRequest,
  entityKey,
  routeTemplate,
  type TrafficLane
} from './traffic-entities.js'
import { applyHistoryNarrowing } from './traffic-entity-history.js'
import { escapeLike, historyNarrowing } from './traffic-history.js'
import {
  histPercentile,
  type JobInput,
  LAT_BOUNDS,
  type TimelapseGroup
} from './traffic-history-analysis.js'
import { storeSearch } from './traffic-history-store.js'
import { changeMarkers } from './traffic-taps/change-markers.js'

const LONG_MS = 120_000
const SAFE_KEY = /^[A-Za-z0-9_.@:-]{1,80}$/

/** UTC ISO without zone (`2026-10-17T09:00:00`) — what a datetime literal must be. */
export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19)
}

async function long<T>(qb: Knex.QueryBuilder | Knex.Raw, timeoutMs = LONG_MS): Promise<T[]> {
  return runLongSql<T>(qb.toQuery(), { timeoutMs })
}

/** Leave development-instance rows out (the same rule as the API analytics pages). */
async function scopeInstances(qb: Knex.QueryBuilder, col = 'instance'): Promise<void> {
  if (!(await hasColumn('nivaro_api_logs', 'instance').catch(() => false))) return
  const keys = devInstanceKeys().filter((k) => SAFE_KEY.test(k))
  if (keys.length) qb.where((w) => w.whereNull(col).orWhereNotIn(col, keys))
}

// ── #2183 the request log per step and node ─────────────────────────────────
/** SQL grouping expression: one route family per request (see `familyEntity`). */
const FAMILY_SQL = `CASE
  WHEN collection IS NOT NULL THEN 'i:' + collection
  WHEN graphql_operation IS NOT NULL THEN 'g:' + graphql_operation
  WHEN path IN ('/graphql', '/api/graphql') THEN 'g:'
  WHEN path LIKE '/api/custom-queries/%/execute' OR path LIKE '/api/pages/%'
    OR path LIKE '/api/inbound/%' OR path LIKE '/api/widgets-internal/%' THEN 'p:' + LEFT(path, 200)
  WHEN path LIKE '/api/pipelines/instance/%'
    THEN 'p:' + LEFT(path, CHARINDEX('/', path + '/', 25) - 1)
  WHEN path LIKE '/api/%' THEN 'p:' + LEFT(path, CHARINDEX('/', path + '/', 6) - 1)
  ELSE 'p:' + LEFT(path, 40) END`

/**
 * The map entity a grouped family stands for (`items/workflows`, `graphql/getX`,
 * `queries/budget`), the live classifier's way. Families the log cannot tell apart further
 * (extension routes, most system routes) land on their first path segment.
 */
export function familyEntity(family: string, method: string): string | null {
  const m = String(method || 'GET').toUpperCase()
  const body = family.slice(2)
  let path: string
  let op: string | null = null
  if (family.startsWith('i:')) path = `/api/items/${body}`
  else if (family.startsWith('g:')) {
    path = '/api/graphql'
    op = body || null
  } else path = body
  const c = classifyRequest({
    method: family.startsWith('g:') ? 'POST' : m,
    path,
    graphqlOperation: op,
    graphqlKind: null
  })
  return c ? entityKey(c.lane, c.entity) : null
}

const HIST_SQL = LAT_BOUNDS.map(
  (b, i) => `SUM(CASE WHEN x.latency_ms < ${b} THEN 1 ELSE 0 END) AS c${i}`
).join(', ')

/**
 * The request log between `from` and `to` (epoch ms) per step of `stepS` seconds and map entity
 * (`e:<lane>/<entity>` keys), with each group's p95 from a cumulative latency histogram. SQL
 * Server only (returns null elsewhere — the caller says the hourly view needs it).
 */
export async function logSteps(
  from: number,
  to: number,
  stepS: number
): Promise<TimelapseGroup[] | null> {
  if (!isMssql(db)) return null
  const stepMin = Math.max(1, Math.round(stepS / 60))
  const inner = db('nivaro_api_logs')
    .where('created_at', '>=', isoUtc(from))
    .where('created_at', '<', isoUtc(to))
    .select(
      db.raw('DATEDIFF(minute, ?, created_at) / ? AS s', [isoUtc(from), stepMin]),
      'method',
      'status',
      'latency_ms',
      db.raw(`${FAMILY_SQL} AS fam`)
    )
  await scopeInstances(inner)
  const sql = `SELECT x.s AS s, x.fam AS fam, x.method AS method, COUNT(*) AS n,
      SUM(CASE WHEN x.status >= 400 THEN 1 ELSE 0 END) AS e, MAX(x.latency_ms) AS mx, ${HIST_SQL}
    FROM (${inner.toQuery()}) x GROUP BY x.s, x.fam, x.method`
  const rows = await runLongSql<Record<string, number | string>>(sql, { timeoutMs: LONG_MS })
  const out = new Map<
    string,
    { s: number; key: string; n: number; e: number; hist: number[]; mx: number }
  >()
  for (const r of rows) {
    const ek = familyEntity(String(r.fam ?? ''), String(r.method ?? 'GET'))
    if (!ek) continue
    const s = Number(r.s)
    const key = `e:${ek}`
    const k = `${s}|${key}`
    const g = out.get(k) ?? {
      s,
      key,
      n: 0,
      e: 0,
      hist: new Array(LAT_BOUNDS.length + 1).fill(0),
      mx: 0
    }
    const n = Number(r.n) || 0
    g.n += n
    g.e += Number(r.e) || 0
    g.mx = Math.max(g.mx, Number(r.mx) || 0)
    // Cumulative "under bound i" counts → per-bucket counts.
    let prev = 0
    for (let i = 0; i < LAT_BOUNDS.length; i++) {
      const c = Number(r[`c${i}`]) || 0
      g.hist[i] += c - prev
      prev = c
    }
    g.hist[LAT_BOUNDS.length] += n - prev
    out.set(k, g)
  }
  return [...out.values()].map((g) => ({
    s: g.s,
    key: g.key,
    n: g.n,
    e: g.e,
    p95: histPercentile(g.hist, 0.95, g.mx)
  }))
}

// ── #2249 people online / active per step ───────────────────────────────────
export interface PeopleSteps {
  /** People with an open socket (sum over instances of each 5-minute sample, the step's max). */
  online: Array<number | null>
  /** Distinct signed-in people with a request in the step. */
  active: number[]
  /** Whether any concurrency sample covers the range (they are written where crons tick). */
  sampled: boolean
}

export async function peopleSteps(from: number, to: number, stepS: number): Promise<PeopleSteps> {
  const steps = Math.max(1, Math.ceil((to - from) / (stepS * 1000)))
  const online: Array<number | null> = new Array(steps).fill(null)
  const active: number[] = new Array(steps).fill(0)
  const stepMin = Math.max(1, Math.round(stepS / 60))
  let sampled = false
  try {
    const samples = (await db('nivaro_concurrency_samples')
      .where('sampled_at', '>=', new Date(from))
      .where('sampled_at', '<', new Date(to))
      .orderBy('sampled_at')
      .limit(50_000)
      .select('sampled_at', 'users')) as Array<{ sampled_at: Date | string; users: number }>
    // Instances sample at the same cron minute: sum per minute, then the step's busiest minute.
    const perMinute = new Map<number, number>()
    for (const s of samples) {
      const m = Math.floor(new Date(s.sampled_at).getTime() / 60_000)
      perMinute.set(m, (perMinute.get(m) ?? 0) + (Number(s.users) || 0))
    }
    for (const [m, users] of perMinute) {
      const i = Math.floor((m * 60_000 - from) / (stepMin * 60_000))
      if (i < 0 || i >= steps) continue
      online[i] = Math.max(online[i] ?? 0, users)
      sampled = true
    }
  } catch {
    /* no samples table: online stays null */
  }
  const inner = db('nivaro_api_logs')
    .where('created_at', '>=', isoUtc(from))
    .where('created_at', '<', isoUtc(to))
    .whereNotNull('user')
    .select(db.raw('DATEDIFF(minute, ?, created_at) / ? AS s', [isoUtc(from), stepMin]), 'user')
  await scopeInstances(inner)
  if (isMssql(db)) {
    const rows = await runLongSql<{ s: number; n: number }>(
      `SELECT x.s AS s, COUNT(DISTINCT x.[user]) AS n FROM (${inner.toQuery()}) x GROUP BY x.s`,
      { timeoutMs: LONG_MS }
    )
    for (const r of rows) {
      const i = Number(r.s)
      if (i >= 0 && i < steps) active[i] = Number(r.n) || 0
    }
  }
  return { online, active, sampled }
}

// ── #2175 search ─────────────────────────────────────────────────────────────
export type SearchKind = 'last_hit' | 'first_error' | 'busiest_hour'
export interface SearchQuery {
  kind: SearchKind
  /** Caller key: `u<UUID>`, `k<api key id>`, `anon`. */
  caller?: string | null
  /** Map entity `<lane>/<entity>`. */
  entity?: string | null
  /** Route template, `GET /api/items/workflows/:id`. */
  route?: string | null
  /** Text the logged error body must contain (first_error). */
  error?: string | null
  /** Partner down node `ext:<id>` (busiest_hour over the outbound log). */
  partner?: string | null
  /** Range: the last `days` days (1–31). */
  days: number
}
export interface SearchHit {
  /** Epoch ms of the moment the answer points at. */
  at: number
  /** For a range answer (busiest hour): its end. */
  until?: number
  route?: string
  status?: number
  latency_ms?: number
  caller?: string
  n?: number
}
export interface SearchAnswer {
  kind: SearchKind
  /** The main answer (null = nothing matched). */
  hit: SearchHit | null
  /** More moments (the next-busiest hours; the latest occurrence of an error). */
  more: SearchHit[]
  /** Matching requests in the range. */
  count: number
  /** The answer comes from a source with less history than asked (the request log keeps 14 days). */
  note?: string
  /** `store` when the long-history telemetry store answered (#2544); absent = the request log. */
  source?: 'store'
}

export const CALLER_KEY = /^(u[0-9A-Fa-f-]{36}|k\d{1,12}|anon|m:[A-Za-z0-9._-]{1,48})$/
export const ENTITY_KEY = /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/
export const ROUTE_RE =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[^\s?#]{0,200}( · [A-Za-z0-9_]{1,120})?$/

/** Narrow a log query to a caller key. */
function applyCaller(q: Knex.QueryBuilder, caller: string): void {
  if (caller === 'anon') {
    q.whereNull('user').where((w) => w.whereNull('api_key_id').orWhereNot('auth', 'api_key'))
  } else if (caller.startsWith('m:')) {
    // #2469 — an MCP client (migration 480; behind it the read fails and reads as unavailable).
    q.where('mcp_client', caller.slice(2))
  } else if (caller.startsWith('k')) {
    q.where('api_key_id', Number(caller.slice(1))).where('auth', 'api_key')
  } else {
    // The column holds the id as the auth layer had it; SQL Server compares it case-insensitively.
    q.where('user', caller.slice(1))
  }
}

/** Narrow a log query to a route template (`:id` segments match any one segment). */
export function routeLike(route: string): { method: string; like: string; op: string | null } {
  const sp = route.indexOf(' ')
  const method = route.slice(0, sp)
  let rest = route.slice(sp + 1)
  let op: string | null = null
  const dot = rest.indexOf(' · ')
  if (dot >= 0) {
    op = rest.slice(dot + 3)
    rest = rest.slice(0, dot)
  }
  const like = rest
    .split('/')
    .map((s) => (s === ':id' ? '%' : escapeLike(s)))
    .join('/')
  return { method, like, op: op === 'anonymous' ? null : op }
}

function applyRoute(q: Knex.QueryBuilder, route: string): void {
  const r = routeLike(route)
  q.where('method', r.method)
  if (r.op) q.where('graphql_operation', r.op)
  q.whereRaw("path LIKE ? ESCAPE '\\'", [r.like])
}

function applyEntity(q: Knex.QueryBuilder, key: string): void {
  const cut = key.indexOf('/')
  const lane = key.slice(0, cut) as TrafficLane
  const entity = key.slice(cut + 1)
  const extUrls = lane === 'extension' ? (extensionRoutes.get(entity) ?? []).map((r) => r.url) : []
  const n = historyNarrowing(lane, entity, extUrls)
  // An extension with no known routes narrows to nothing — never to every row.
  if (!n.column && !n.like?.length) {
    q.whereRaw('1 = 0')
    return
  }
  applyHistoryNarrowing(q, n)
}

const LOG_DAYS_KEPT = LOCAL_LOG_DAYS

export async function searchHistory(
  sq: SearchQuery,
  nowMs = Date.now(),
  signal?: AbortSignal
): Promise<SearchAnswer> {
  const days = Math.max(1, Math.min(STORE_MAX_DAYS, Math.round(sq.days)))
  const from = nowMs - days * 86_400_000
  if (sq.kind === 'busiest_hour' && sq.partner) return partnerBusiestHour(sq.partner, from, nowMs)
  let note =
    days > LOG_DAYS_KEPT
      ? `The request log keeps about ${LOG_DAYS_KEPT} days, so older moments may be missing.`
      : undefined
  // #2544 — past the request log's 14 days, the long-history store answers the whole window.
  if (days > LOG_DAYS_KEPT && storeEnabled()) {
    try {
      return { ...(await storeSearch(sq, from, nowMs, signal)), source: 'store' }
    } catch {
      note = `The long-history store did not answer, so only the request log's last ${LOG_DAYS_KEPT} days were searched.`
    }
  }
  const base = () => {
    const q = db('nivaro_api_logs')
      .where('created_at', '>=', isoUtc(from))
      .where('created_at', '<', isoUtc(nowMs))
    if (sq.caller) applyCaller(q, sq.caller)
    if (sq.route) applyRoute(q, sq.route)
    if (sq.entity) applyEntity(q, sq.entity)
    if (sq.kind === 'first_error') {
      q.where('status', '>=', 400)
      if (sq.error) q.whereRaw("error LIKE ? ESCAPE '\\'", [`%${escapeLike(sq.error)}%`])
    }
    return q
  }
  const countQ = base().count('* as n')
  await scopeInstances(countQ)
  const countRows = await long<{ n: number | string }>(countQ)
  const count = Number(countRows[0]?.n ?? 0)
  const answer: SearchAnswer = {
    kind: sq.kind,
    hit: null,
    more: [],
    count,
    ...(note ? { note } : {})
  }
  if (!count) return answer
  const hitOf = (r: Record<string, unknown>): SearchHit => ({
    at: new Date(r.created_at as string).getTime(),
    route: routeTemplate(String(r.method), String(r.path), (r.graphql_operation as string) ?? null),
    status: Number(r.status),
    latency_ms: Number(r.latency_ms),
    caller: callerKeyFor({
      authMethod: (r.auth as string) ?? null,
      apiKeyId: (r.api_key_id as number) ?? null,
      userId: (r.user as string) ?? null
    })
  })
  const cols = [
    'created_at',
    'method',
    'path',
    'status',
    'latency_ms',
    'graphql_operation',
    'auth',
    'api_key_id',
    'user'
  ]
  if (sq.kind === 'last_hit' || sq.kind === 'first_error') {
    const first = base()
      .select(cols)
      .orderBy('created_at', sq.kind === 'last_hit' ? 'desc' : 'asc')
      .limit(1)
    await scopeInstances(first)
    const rows = await long<Record<string, unknown>>(first)
    if (rows[0]) answer.hit = hitOf(rows[0])
    if (sq.kind === 'first_error') {
      const last = base().select(cols).orderBy('created_at', 'desc').limit(1)
      await scopeInstances(last)
      const lr = await long<Record<string, unknown>>(last)
      if (lr[0] && count > 1) answer.more.push(hitOf(lr[0]))
    }
    return answer
  }
  // busiest hour: requests per hour, the five busiest
  const inner = base().select(db.raw('DATEDIFF(hour, ?, created_at) AS h', [isoUtc(from)]))
  await scopeInstances(inner)
  const rows = await runLongSql<{ h: number; n: number }>(
    `SELECT TOP 5 x.h AS h, COUNT(*) AS n FROM (${inner.toQuery()}) x GROUP BY x.h ORDER BY COUNT(*) DESC, x.h DESC`,
    { timeoutMs: LONG_MS }
  )
  const hourStart = Math.floor(from / 3600_000) * 3600_000
  const hits = rows.map((r) => {
    // DATEDIFF(hour) counts hour boundaries crossed from `from`.
    const at = hourStart + Number(r.h) * 3600_000
    return { at, until: at + 3600_000, n: Number(r.n) }
  })
  answer.hit = hits[0] ?? null
  answer.more = hits.slice(1)
  return answer
}

async function partnerBusiestHour(
  partner: string,
  from: number,
  to: number
): Promise<SearchAnswer> {
  const id = Number(partner.slice(4))
  const inner = db('nivaro_outbound_log')
    .where('api_id', id)
    .where('created_at', '>=', isoUtc(from))
    .where('created_at', '<', isoUtc(to))
  const countRows = await long<{ n: number | string }>(inner.clone().count('* as n'))
  const count = Number(countRows[0]?.n ?? 0)
  const answer: SearchAnswer = { kind: 'busiest_hour', hit: null, more: [], count }
  if (!count) return answer
  const q = inner.clone().select(db.raw('DATEDIFF(hour, ?, created_at) AS h', [isoUtc(from)]))
  const rows = await runLongSql<{ h: number; n: number }>(
    `SELECT TOP 5 x.h AS h, COUNT(*) AS n FROM (${q.toQuery()}) x GROUP BY x.h ORDER BY COUNT(*) DESC, x.h DESC`,
    { timeoutMs: LONG_MS }
  )
  const hourStart = Math.floor(from / 3600_000) * 3600_000
  const hits = rows.map((r) => {
    const at = hourStart + Number(r.h) * 3600_000
    return { at, until: at + 3600_000, n: Number(r.n) }
  })
  answer.hit = hits[0] ?? null
  answer.more = hits.slice(1)
  return answer
}

// ── #2193 / #2252 one route's requests ──────────────────────────────────────
export const ROUTE_ROW_CAP = 20_000
export interface RouteRows {
  latencies: number[]
  rows: Array<{ latency_ms: number; query: string | null }>
  truncated: boolean
}

/** One route's logged requests in the last `hours` (newest ROUTE_ROW_CAP), matched exactly. */
export async function routeRows(key: string, route: string, hours: number): Promise<RouteRows> {
  const since = Date.now() - hours * 3600_000
  const q = db('nivaro_api_logs')
    .where('created_at', '>=', isoUtc(since))
    .orderBy('created_at', 'desc')
    .limit(ROUTE_ROW_CAP)
    .select('method', 'path', 'latency_ms', 'graphql_operation')
  if (await hasColumn('nivaro_api_logs', 'query').catch(() => false)) q.select('query')
  applyEntity(q, key)
  applyRoute(q, route)
  await scopeInstances(q)
  const raw = await long<{
    method: string
    path: string
    latency_ms: number
    graphql_operation: string | null
    query?: string | null
  }>(q)
  const rows = raw.filter((r) => routeTemplate(r.method, r.path, r.graphql_operation) === route)
  return {
    latencies: rows.map((r) => Number(r.latency_ms) || 0),
    rows: rows.map((r) => ({ latency_ms: Number(r.latency_ms) || 0, query: r.query ?? null })),
    truncated: raw.length >= ROUTE_ROW_CAP
  }
}

// ── #2165 jobs ───────────────────────────────────────────────────────────────
export interface CronListEntry {
  id: string
  expression: string
  heavy?: boolean
  timezone?: string
  paused?: boolean
  after?: string | null
}

/** Scheduled (not run-now) completed runs of the listed jobs over the last `days` days. */
export async function jobInputs(entries: CronListEntry[], days: number): Promise<JobInput[]> {
  const since = new Date(Date.now() - days * 86_400_000)
  const ids = entries
    .filter((e) => !e.paused)
    .map((e) => e.id)
    .slice(0, 500)
  if (!ids.length) return []
  let rows: Array<{ job_id: string; started_at: Date | string; duration_ms: number | null }> = []
  try {
    const q = db('nivaro_job_runs')
      .where('kind', 'cron')
      .where('status', 'completed')
      .whereNull('triggered_by')
      .where('started_at', '>=', since)
      .orderBy('started_at', 'desc')
      .limit(20_000)
      .select('job_id', 'started_at', 'duration_ms')
    // ≤ 500 ids: well under the parameter cap.
    q.whereIn('job_id', ids)
    rows = await q
  } catch {
    rows = []
  }
  const by = new Map<string, Array<{ at: number; ms: number }>>()
  for (const r of rows) {
    const list = by.get(r.job_id) ?? []
    list.push({ at: new Date(r.started_at).getTime(), ms: Number(r.duration_ms) || 0 })
    by.set(r.job_id, list)
  }
  return entries
    .filter((e) => by.has(e.id))
    .map((e) => ({
      id: e.id,
      expression: e.expression,
      heavy: !!e.heavy,
      timezone: e.timezone,
      runs: by.get(e.id) ?? []
    }))
}

// ── markers for a long range ─────────────────────────────────────────────────
export interface HistoryMarker {
  kind: string
  at: number
  until?: number
  label: string
}

/** Change markers + incident threads in a range (epoch ms), oldest first. */
export async function timelapseMarkers(from: number, to: number): Promise<HistoryMarker[]> {
  const out: HistoryMarker[] = []
  try {
    out.push(...(await changeMarkers(from, to)))
  } catch {
    /* markers are decoration */
  }
  try {
    if (await db.schema.hasTable('nivaro_ops_incidents')) {
      const rows = (await db('nivaro_ops_incidents')
        .where('started_at', '<=', new Date(to))
        .where((w) => w.whereNull('ended_at').orWhere('ended_at', '>=', new Date(from)))
        .orderBy('started_at', 'asc')
        .limit(50)
        .select('kind', 'title', 'started_at', 'ended_at')) as Array<{
        kind: string
        title: string
        started_at: Date | string
        ended_at: Date | string | null
      }>
      for (const r of rows)
        out.push({
          kind: 'incident',
          at: Math.max(from, new Date(r.started_at).getTime()),
          until: Math.min(to, r.ended_at ? new Date(r.ended_at).getTime() : to),
          label: `${r.kind === 'alert' ? 'Alert' : 'Incident'}: ${String(r.title).slice(0, 120)}`
        })
    }
  } catch {
    /* no incidents table */
  }
  return out.filter((m) => Number.isFinite(m.at)).sort((a, b) => a.at - b.at)
}
