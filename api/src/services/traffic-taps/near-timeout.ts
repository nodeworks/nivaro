// api/src/services/traffic-taps/near-timeout.ts
/**
 * #1169 — near-timeout lens: requests that used more than NEAR_SHARE (80%) of a budget before
 * anything failed, grouped per entity. Two budgets:
 *   - db:    the longest single statement against the driver's request timeout (tedious'
 *            connection-level requestTimeout, 15 s here) — a statement past it is cancelled and
 *            the request errors;
 *   - proxy: the whole request against the reverse proxy's read timeout (TRAFFIC_PROXY_TIMEOUT_MS,
 *            default 60 s — traefik v3 / nginx defaults) — past it the caller sees a 504 while the
 *            API keeps working.
 * Requests that went past a budget are counted too ("timed out"), so the lens shows the slide from
 * "close" to "failing". Measured per request from request-trace (longest statement, driver
 * timeouts); the 24 h history route reads nivaro_api_logs latency against the same budgets.
 *
 * frame:    { [entityKey]: n } near/over-budget requests in that second.
 * snapshot: { budgets, entities: [{ key, n, over, worst_pct }] } worst first.
 * entity:   { n, near_db, over_db, near_proxy, over_proxy, worst_pct, recent: [...] }.
 */
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { requestMeasure } from '../request-trace.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { MinuteSlots } from './minute-slots.js'

export const NEAR_TIMEOUT_TAP = 'near-timeout'
/** Share of a budget that counts as "near". */
export const NEAR_SHARE = 0.8
/** tedious' default requestTimeout — db/index.ts does not override it. */
export const DB_TIMEOUT_MS = Math.max(1000, Number(process.env.DB_REQUEST_TIMEOUT_MS) || 15_000)
/** The reverse proxy's read timeout in front of the API. */
export const PROXY_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.TRAFFIC_PROXY_TIMEOUT_MS) || 60_000
)
const RECENT = 8
const ENTITY_CAP = 400
const SQL_TEXT = 300

const S = { nearDb: 0, overDb: 1, nearProxy: 2, overProxy: 3 } as const
const SLOTS = 4

export type Budget = 'db' | 'proxy'
export interface NearTimeoutHit {
  budget: Budget
  /** Share of the budget used (0.8 = 80%); over 1 = went past it. */
  used: number
  over: boolean
}

/**
 * Which budgets one request came close to (or past). Pure: `latencyMs` the whole request,
 * `maxStmtMs` its longest statement, `timeouts` statements the driver cancelled, `status` the
 * response status (a 504 is the proxy giving up even when the API's own clock read less).
 */
export function judgeRequest(
  r: { latencyMs: number; maxStmtMs: number; timeouts: number; status: number },
  budgets: { db: number; proxy: number } = { db: DB_TIMEOUT_MS, proxy: PROXY_TIMEOUT_MS }
): NearTimeoutHit[] {
  const out: NearTimeoutHit[] = []
  const dbUsed = r.timeouts > 0 ? Math.max(1, r.maxStmtMs / budgets.db) : r.maxStmtMs / budgets.db
  if (dbUsed >= NEAR_SHARE) out.push({ budget: 'db', used: dbUsed, over: dbUsed >= 1 })
  const proxyUsed =
    r.status === 504 ? Math.max(1, r.latencyMs / budgets.proxy) : r.latencyMs / budgets.proxy
  if (proxyUsed >= NEAR_SHARE) out.push({ budget: 'proxy', used: proxyUsed, over: proxyUsed >= 1 })
  return out
}

export interface NearTimeoutRecent {
  at: string
  route: string
  caller: string
  ms: number
  stmt_ms: number
  budget: Budget
  used_pct: number
  over: boolean
  sql: string | null
}
interface EntityState {
  slots: MinuteSlots
  /** Worst share per minute (max, not sum) kept beside the counts. */
  worst: Map<number, number>
  recent: NearTimeoutRecent[]
}
interface State {
  entities: Map<string, EntityState>
  second: Map<string, number>
  secondAt: number
}
const state = (): State =>
  tapState<State>(NEAR_TIMEOUT_TAP, () => ({ entities: new Map(), second: new Map(), secondAt: 0 }))

export interface EntityNearTimeout {
  n: number
  over: number
  near_db: number
  over_db: number
  near_proxy: number
  over_proxy: number
  worst_pct: number
  recent: NearTimeoutRecent[]
}

function summarize(e: EntityState, windowS: number, sec: number): EntityNearTimeout | null {
  const v = e.slots.sum(windowS, sec)
  const n = v[S.nearDb] + v[S.overDb] + v[S.nearProxy] + v[S.overProxy]
  if (n <= 0) return null
  const fromMin = Math.floor((sec - windowS) / 60)
  let worst = 0
  for (const [mn, w] of e.worst) if (mn >= fromMin && w > worst) worst = w
  const since = (sec - windowS) * 1000
  return {
    n,
    over: v[S.overDb] + v[S.overProxy],
    near_db: v[S.nearDb],
    over_db: v[S.overDb],
    near_proxy: v[S.nearProxy],
    over_proxy: v[S.overProxy],
    worst_pct: Math.round(worst * 100),
    recent: e.recent.filter((r) => Date.parse(r.at) >= since)
  }
}

const tap: TrafficTap = {
  id: NEAR_TIMEOUT_TAP,
  onRequest(c) {
    const m = requestMeasure(c.ev.req)
    const hits = judgeRequest({
      latencyMs: c.ev.latencyMs,
      maxStmtMs: m?.maxStatementMs ?? 0,
      timeouts: m?.statementTimeouts ?? 0,
      status: c.ev.status
    })
    if (hits.length === 0) return
    const st = state()
    let e = st.entities.get(c.entityKey)
    if (!e) {
      if (st.entities.size >= ENTITY_CAP) return
      e = { slots: new MinuteSlots(SLOTS), worst: new Map(), recent: [] }
      st.entities.set(c.entityKey, e)
    }
    const mn = Math.floor(c.sec / 60)
    for (const h of hits) {
      const slot =
        h.budget === 'db' ? (h.over ? S.overDb : S.nearDb) : h.over ? S.overProxy : S.nearProxy
      e.slots.add(c.sec, slot, 1)
      if (h.used > (e.worst.get(mn) ?? 0)) e.worst.set(mn, h.used)
    }
    if (e.worst.size > 70)
      for (const k of [...e.worst.keys()].sort((a, b) => a - b).slice(0, 10)) e.worst.delete(k)
    // The request's worst budget is its headline.
    const top = hits.reduce((a, b) => (b.used > a.used ? b : a))
    e.recent.unshift({
      at: new Date(c.ev.at).toISOString(),
      route: c.route,
      caller: c.caller,
      ms: Math.round(c.ev.latencyMs),
      stmt_ms: Math.round(m?.maxStatementMs ?? 0),
      budget: top.budget,
      used_pct: Math.round(top.used * 100),
      over: top.over,
      sql: m?.maxStatementSql ? m.maxStatementSql.slice(0, SQL_TEXT) : null
    })
    if (e.recent.length > RECENT) e.recent.pop()
    if (st.secondAt !== c.sec) {
      st.second.clear()
      st.secondAt = c.sec
    }
    st.second.set(c.entityKey, (st.second.get(c.entityKey) ?? 0) + 1)
    if (c.event) c.event.tags = [...(c.event.tags ?? []), top.over ? 'timed out' : 'near timeout']
  },
  frame(sec) {
    const st = state()
    if (st.secondAt !== sec || st.second.size === 0) return undefined
    const out = Object.fromEntries(st.second)
    st.second.clear()
    return out
  },
  snapshot(windowS, sec) {
    const entities: Array<{ key: string; n: number; over: number; worst_pct: number }> = []
    for (const [key, e] of state().entities) {
      const s = summarize(e, windowS, sec)
      if (s) entities.push({ key, n: s.n, over: s.over, worst_pct: s.worst_pct })
    }
    if (!entities.length) return undefined
    return {
      budgets: budgetsWire(),
      entities: entities.sort((a, b) => b.over - a.over || b.worst_pct - a.worst_pct)
    }
  },
  entitySnapshot(entityKey, windowS, sec) {
    const e = state().entities.get(entityKey)
    if (!e) return undefined
    const s = summarize(e, windowS, sec)
    return s ? { ...s, budgets: budgetsWire() } : undefined
  },
  sweep(sec) {
    const st = state()
    const cutoff = Math.floor(sec / 60) - 61
    for (const [k, e] of st.entities) {
      for (const mn of e.worst.keys()) if (mn < cutoff) e.worst.delete(mn)
      if (e.worst.size === 0 && e.slots.sum(3600, sec).every((x) => x === 0)) st.entities.delete(k)
    }
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)

export function budgetsWire(): { db_ms: number; proxy_ms: number; near_share: number } {
  return { db_ms: DB_TIMEOUT_MS, proxy_ms: PROXY_TIMEOUT_MS, near_share: NEAR_SHARE }
}

/** The lens's figures for the route (`/db-lens/near-timeout`). */
export function nearTimeoutLens(windowS: number, sec: number) {
  return tap.snapshot?.(windowS, sec) ?? { budgets: budgetsWire(), entities: [] }
}

// ── 24 h history from the api log ─────────────────────────────────────────────
export interface NearTimeoutHistoryRow {
  key: string
  near_proxy: number
  over_proxy: number
  db_timeouts: number
  worst_ms: number
}

/**
 * Per entity over the last `hours`: requests the api log saw at ≥ 80% of the proxy budget, past
 * it (or a 504), and requests that failed on a driver statement timeout (their error text). The
 * live tap needs no database; this one reads at most 5,000 rows (newest first).
 */
export async function nearTimeoutHistory(
  hours: number,
  classify: (r: {
    method: string
    path: string
    graphql_operation: string | null
    graphql_kind: string | null
  }) => string | null
): Promise<{ hours: number; rows: NearTimeoutHistoryRow[]; scanned: number }> {
  const since = new Date(Date.now() - hours * 3600_000)
  const gql = await hasColumn('nivaro_api_logs', 'graphql_operation').catch(() => false)
  const cols = ['method', 'path', 'status', 'latency_ms', 'error']
  if (gql) cols.push('graphql_operation', 'graphql_kind')
  const near = Math.round(PROXY_TIMEOUT_MS * NEAR_SHARE)
  const rows = (await db('nivaro_api_logs')
    .where('created_at', '>=', since)
    .andWhere((q) =>
      q
        .where('latency_ms', '>=', near)
        .orWhere('status', 504)
        .orWhere('error', 'like', '%Timeout: Request failed to complete%')
        .orWhere('error', 'like', '%ETIMEOUT%')
    )
    .orderBy('created_at', 'desc')
    .limit(5000)
    .select(cols)
    .catch(() => [])) as Array<{
    method: string
    path: string
    status: number
    latency_ms: number
    error: string | null
    graphql_operation?: string | null
    graphql_kind?: string | null
  }>
  const by = new Map<string, NearTimeoutHistoryRow>()
  for (const r of rows) {
    const key = classify({
      method: r.method,
      path: r.path,
      graphql_operation: r.graphql_operation ?? null,
      graphql_kind: r.graphql_kind ?? null
    })
    if (!key) continue
    const row = by.get(key) ?? { key, near_proxy: 0, over_proxy: 0, db_timeouts: 0, worst_ms: 0 }
    const ms = Number(r.latency_ms) || 0
    const dbTimeout = /Timeout: Request failed to complete|ETIMEOUT/i.test(String(r.error ?? ''))
    if (dbTimeout) row.db_timeouts++
    if (Number(r.status) === 504 || ms >= PROXY_TIMEOUT_MS) row.over_proxy++
    else if (ms >= near) row.near_proxy++
    if (ms > row.worst_ms) row.worst_ms = ms
    by.set(key, row)
  }
  return {
    hours,
    scanned: rows.length,
    rows: [...by.values()].sort(
      (a, b) =>
        b.over_proxy + b.db_timeouts - (a.over_proxy + a.db_timeouts) || b.worst_ms - a.worst_ms
    )
  }
}
