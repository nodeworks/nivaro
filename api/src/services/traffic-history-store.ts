// api/src/services/traffic-history-store.ts
/**
 * Traffic Map long history from the telemetry store (#2544) — the same answers the request-log
 * reads in traffic-history-reads.ts give, for windows older than the 14 days nivaro_api_logs
 * keeps. Each function builds its LogsQL from typed, validated parameters (`lq()` quotes every
 * value) and maps the store's rows onto the shapes the routes already return.
 *
 *  - storeSearch   — last hit / first error / busiest hour (#2175)
 *  - storeSteps    — requests, errors and p95 per step and map node (time-lapse, #2183)
 *  - storeActive   — distinct signed-in people per step (#2249)
 *  - storeSloRows  — requests, 5xx / 4xx and p95 per instance and day (SLO, #666)
 */
import {
  baseFilter,
  containsRe,
  logsQuery,
  lq,
  type StoreRow,
  stepDur,
  storeConfig,
  storeTime
} from './telemetry-store.js'
import type { TimelapseGroup } from './traffic-history-analysis.js'
import type { SearchAnswer, SearchHit, SearchQuery } from './traffic-history-reads.js'

const env = () => storeConfig()?.env ?? null
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** The filter part of a search: env + access lines + caller / route / node / error. */
export function searchFilter(sq: SearchQuery, envLabel: string | null): string {
  const parts = [baseFilter(envLabel)]
  if (sq.caller) {
    // Caller keys are written upper-cased (callerKeyFor); `u<uuid>` may arrive in either case.
    const c = sq.caller === 'anon' ? 'anon' : sq.caller[0] + sq.caller.slice(1).toUpperCase()
    parts.push(`caller:=${lq(c)}`)
  }
  if (sq.route) parts.push(`route:=${lq(sq.route)}`)
  if (sq.entity) parts.push(`entity:=${lq(sq.entity)}`)
  if (sq.kind === 'first_error') {
    parts.push('status:>=400')
    if (sq.error) parts.push(`err:~${lq(containsRe(sq.error))}`)
  }
  return parts.join(' ')
}

function hitOf(r: StoreRow): SearchHit {
  return {
    at: storeTime(r._time),
    route: r.route,
    status: num(r.status),
    latency_ms: num(r.ms),
    caller: r.caller
  }
}

/** #2175 over [from, to) from the store. Throws StoreUnavailableError when it does not answer. */
export async function storeSearch(
  sq: SearchQuery,
  from: number,
  to: number,
  signal?: AbortSignal
): Promise<SearchAnswer> {
  const f = searchFilter(sq, env())
  const [countRow] = await logsQuery(`${f} | stats count() as n`, from, to, { signal })
  const count = num(countRow?.n)
  const answer: SearchAnswer = { kind: sq.kind, hit: null, more: [], count }
  if (!count) return answer
  const pick = 'fields _time, route, status, ms, caller'
  if (sq.kind === 'last_hit' || sq.kind === 'first_error') {
    const dir = sq.kind === 'last_hit' ? 'desc' : 'asc'
    const [first] = await logsQuery(`${f} | sort by (_time ${dir}) limit 1 | ${pick}`, from, to, {
      signal
    })
    if (first) answer.hit = hitOf(first)
    if (sq.kind === 'first_error' && count > 1) {
      const [last] = await logsQuery(`${f} | sort by (_time desc) limit 1 | ${pick}`, from, to, {
        signal
      })
      if (last) answer.more.push(hitOf(last))
    }
    return answer
  }
  // busiest hour: requests per clock hour, the five busiest
  const rows = await logsQuery(
    `${f} | stats by (_time:1h) count() as n | sort by (n desc, _time desc) limit 5`,
    from,
    to,
    { signal }
  )
  const hits = rows
    .map((r) => ({ at: storeTime(r._time), n: num(r.n) }))
    .filter((h) => Number.isFinite(h.at))
    .map((h) => ({ at: h.at, until: h.at + 3600_000, n: h.n }))
  answer.hit = hits[0] ?? null
  answer.more = hits.slice(1)
  return answer
}

/** Step index of a store bucket time inside [from, to), or -1. */
export function stepIndex(t: number, from: number, to: number, stepS: number): number {
  if (!Number.isFinite(t) || t < from || t >= to) return -1
  return Math.floor((t - from) / (stepS * 1000))
}

/** Store rows (`_time`, `entity`, `n`, `e`, `p95`) → the time-lapse groups (`e:<lane>/<entity>`). */
export function stepsFromRows(
  rows: StoreRow[],
  from: number,
  to: number,
  stepS: number
): TimelapseGroup[] {
  const out: TimelapseGroup[] = []
  for (const r of rows) {
    const s = stepIndex(storeTime(r._time), from, to, stepS)
    if (s < 0 || !r.entity) continue
    out.push({ s, key: `e:${r.entity}`, n: num(r.n), e: num(r.e), p95: num(r.p95) })
  }
  return out
}

/** Requests, errors and p95 per step and map node over [from, to). */
export async function storeSteps(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<TimelapseGroup[]> {
  const rows = await logsQuery(
    `${baseFilter(env())} | stats by (_time:${stepDur(stepS)}, entity) count() as n, count() if (status:>=400) as e, quantile(0.95, ms) as p95`,
    from,
    to,
    { signal }
  )
  return stepsFromRows(rows, from, to, stepS)
}

const TOP_CALLERS = 40

/**
 * Callers (`c:<caller key>`) per step over [from, to) from the raw access lines — the
 * time-lapse's caller nodes when it reads the telemetry stack (the stack keeps no per-minute
 * series per person).
 */
export async function storeCallerSteps(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<TimelapseGroup[]> {
  const base = baseFilter(env())
  // The busiest callers first (the time-lapse keeps 40 nodes), so a busy month of people does
  // not run into the store's row cap.
  const top = await logsQuery(
    `${base} | stats by (caller) count() as n | sort by (n desc) limit ${TOP_CALLERS}`,
    from,
    to,
    { signal }
  )
  const callers = top.map((r) => r.caller).filter((c): c is string => !!c)
  if (!callers.length) return []
  const rows = await logsQuery(
    `${base} caller:in(${callers.map(lq).join(',')}) | stats by (_time:${stepDur(stepS)}, caller) count() as n, count() if (status:>=400) as e, quantile(0.95, ms) as p95`,
    from,
    to,
    { signal }
  )
  const out: TimelapseGroup[] = []
  for (const r of rows) {
    const s = stepIndex(storeTime(r._time), from, to, stepS)
    if (s < 0 || !r.caller) continue
    out.push({ s, key: `c:${r.caller}`, n: num(r.n), e: num(r.e), p95: num(r.p95) })
  }
  return out
}

/** Distinct signed-in people (`u…` callers) per step over [from, to). */
export async function storeActive(
  from: number,
  to: number,
  stepS: number,
  signal?: AbortSignal
): Promise<number[]> {
  const steps = Math.max(1, Math.ceil((to - from) / (stepS * 1000)))
  const active: number[] = new Array(steps).fill(0)
  const rows = await logsQuery(
    `${baseFilter(env())} caller:u* | stats by (_time:${stepDur(stepS)}) count_uniq(caller) as n`,
    from,
    to,
    { signal }
  )
  for (const r of rows) {
    const i = stepIndex(storeTime(r._time), from, to, stepS)
    if (i >= 0 && i < steps) active[i] = num(r.n)
  }
  return active
}

export interface StoreSloDay {
  instance: string
  day: string
  n: number
  e5: number
  e4: number
  p95: number | null
}

/** Per instance and UTC day: requests, 5xx, 4xx and p95, plus each instance's whole-window p95. */
export async function storeSloRows(
  from: number,
  to: number
): Promise<{ days: StoreSloDay[]; p95ByInstance: Map<string, number | null> }> {
  const base = baseFilter(env())
  const [dayRows, allRows] = await Promise.all([
    logsQuery(
      `${base} | stats by (inst, _time:1d) count() as n, count() if (status:>=500) as e5, count() if (status:>=400 status:<500) as e4, quantile(0.95, ms) as p95`,
      from,
      to
    ),
    logsQuery(`${base} | stats by (inst) quantile(0.95, ms) as p95`, from, to)
  ])
  const days: StoreSloDay[] = []
  for (const r of dayRows) {
    const t = storeTime(r._time)
    if (!Number.isFinite(t)) continue
    days.push({
      instance: r.inst || '(unknown)',
      day: new Date(t).toISOString().slice(0, 10),
      n: num(r.n),
      e5: num(r.e5),
      e4: num(r.e4),
      p95: r.p95 != null && r.p95 !== '' ? num(r.p95) : null
    })
  }
  const p95ByInstance = new Map<string, number | null>()
  for (const r of allRows)
    p95ByInstance.set(r.inst || '(unknown)', r.p95 != null && r.p95 !== '' ? num(r.p95) : null)
  return { days, p95ByInstance }
}
