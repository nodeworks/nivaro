// api/src/services/traffic-taps/request-cost.ts
/**
 * Traffic Map tap `request-cost` — what each entity's requests cost inside the process:
 *   #1108 round trips + SQL time per request, and the N+1 badge (avg trips over a threshold),
 *   #1151 the latency split (auth / metadata / SQL / hooks / serialization / the rest),
 *   #1146 row-filter + User Scope enforcement time,
 *   #1145 write amplification (writes a request's direct writes caused: rollups, queue cache
 *         rows, integrity checks, revisions, activity rows).
 * Fed by request-trace's per-request measure, read once at onResponse. Memory only.
 */
import { noteDerivedWrite, requestMeasure } from '../request-trace.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { MinuteSlots } from './minute-slots.js'

export const REQUEST_COST_TAP = 'request-cost'

/** Average round trips per request above which an entity is badged N+1. */
export const N_PLUS_ONE_AVG_TRIPS = Math.max(
  2,
  Number(process.env.TRAFFIC_N_PLUS_ONE_TRIPS ?? 40) || 40
)
/** Fewer requests than this in the window never earn a badge (one odd request is not a pattern). */
export const N_PLUS_ONE_MIN_REQUESTS = 3
/** A span running one statement shape this many times counts as an N+1 shape (request-trace). */
export const REPEAT_SHAPE_MIN = 5
const ENTITY_CAP = 600
const SQL_TEXT_CAP = 400

// slot layout
const S = {
  n: 0,
  queries: 1,
  sql: 2,
  auth: 3,
  meta: 4,
  hooks: 5,
  ser: 6,
  total: 7,
  access: 8,
  accessN: 9,
  repeatReq: 10,
  writeReq: 11,
  // derived writes: direct, rollup, queue, integrity, revision, activity
  derived: 12,
  /** All database wait (wall), inside phases or not. */
  db: 18
} as const
const SLOTS = 19
export const DERIVED_LABELS = ['direct', 'rollup', 'queue', 'integrity', 'revision', 'activity']

interface EntityCost {
  slots: MinuteSlots
  /** The most repeated statement shape seen lately (SQL text with placeholders, never values). */
  repeatSql: string | null
  repeatN: number
}
interface State {
  entities: Map<string, EntityCost>
}
const state = () => tapState<State>(REQUEST_COST_TAP, () => ({ entities: new Map() }))

/** The latency split of one request: SQL capped at the total, the timed phases scaled down when
 *  overlap makes them add past it, `other` = what nothing timed. Sums to `total`. */
export function splitLatency(m: {
  total: number
  sql: number
  auth: number
  meta: number
  hooks: number
  ser: number
}): { sql: number; auth: number; meta: number; hooks: number; ser: number; other: number } {
  const total = Math.max(0, m.total)
  const parts = [m.sql, m.auth, m.meta, m.hooks, m.ser].map((v) =>
    Number.isFinite(v) && v > 0 ? v : 0
  )
  const sum = parts.reduce((a, b) => a + b, 0)
  const k = sum > total && sum > 0 ? total / sum : 1
  const [sql, auth, meta, hooks, ser] = parts.map((v) => v * k)
  return {
    sql,
    auth,
    meta,
    hooks,
    ser,
    other: Math.max(0, total - (sql + auth + meta + hooks + ser))
  }
}

function entityOf(key: string): EntityCost | null {
  const map = state().entities
  let e = map.get(key)
  if (e) return e
  if (map.size >= ENTITY_CAP) return null
  e = { slots: new MinuteSlots(SLOTS), repeatSql: null, repeatN: 0 }
  map.set(key, e)
  return e
}

export interface CostSummary {
  n: number
  avg_trips: number
  avg_sql_ms: number
  sql_share: number
  n_plus_one: boolean
}

/** Figures over the window for one entity (null when it ran no measured request). */
export function costSummary(key: string, windowS: number, sec: number): CostSummary | null {
  const e = state().entities.get(key)
  if (!e) return null
  const v = e.slots.sum(windowS, sec)
  const n = v[S.n]
  if (n <= 0) return null
  const avgTrips = v[S.queries] / n
  return {
    n,
    avg_trips: round1(avgTrips),
    avg_sql_ms: round1(v[S.db] / n),
    sql_share: v[S.total] > 0 ? round3(Math.min(1, v[S.db] / v[S.total])) : 0,
    n_plus_one: n >= N_PLUS_ONE_MIN_REQUESTS && avgTrips > N_PLUS_ONE_AVG_TRIPS
  }
}

export interface CostDetail extends CostSummary {
  window_s: number
  threshold: number
  min_requests: number
  avg_ms: number
  /** Average ms per request in each part; they add up to avg_ms. */
  breakdown: {
    auth: number
    metadata: number
    sql: number
    hooks: number
    serialization: number
    other: number
  }
  access: { avg_ms: number; share: number; checked: number }
  repeat: { requests: number; share: number; sql: string | null; n: number } | null
  amplification: {
    write_requests: number
    direct: number
    derived: Record<string, number>
    derived_total: number
    /** derived writes per direct write (null without direct writes). */
    factor: number | null
  } | null
}

export function costDetail(key: string, windowS: number, sec: number): CostDetail | null {
  const e = state().entities.get(key)
  const sum = costSummary(key, windowS, sec)
  if (!e || !sum) return null
  const v = e.slots.sum(windowS, sec)
  const n = v[S.n]
  const per = (x: number) => round1(x / n)
  const direct = v[S.derived]
  const derived: Record<string, number> = {}
  let derivedTotal = 0
  for (let i = 1; i < DERIVED_LABELS.length; i++) {
    const c = Math.round(v[S.derived + i])
    derived[DERIVED_LABELS[i]] = c
    derivedTotal += c
  }
  return {
    ...sum,
    window_s: windowS,
    threshold: N_PLUS_ONE_AVG_TRIPS,
    min_requests: N_PLUS_ONE_MIN_REQUESTS,
    avg_ms: per(v[S.total]),
    breakdown: {
      auth: per(v[S.auth]),
      metadata: per(v[S.meta]),
      sql: per(v[S.sql]),
      hooks: per(v[S.hooks]),
      serialization: per(v[S.ser]),
      other: per(Math.max(0, v[S.total] - v[S.auth] - v[S.meta] - v[S.sql] - v[S.hooks] - v[S.ser]))
    },
    access: {
      avg_ms: v[S.accessN] > 0 ? Math.round((100 * v[S.access]) / v[S.accessN]) / 100 : 0,
      share: v[S.total] > 0 ? round3(v[S.access] / v[S.total]) : 0,
      checked: Math.round(v[S.accessN])
    },
    repeat:
      v[S.repeatReq] > 0
        ? {
            requests: Math.round(v[S.repeatReq]),
            share: round3(v[S.repeatReq] / n),
            sql: e.repeatSql,
            n: e.repeatN
          }
        : null,
    amplification:
      v[S.writeReq] > 0 || derivedTotal > 0
        ? {
            write_requests: Math.round(v[S.writeReq]),
            direct: Math.round(direct),
            derived,
            derived_total: derivedTotal,
            factor: direct > 0 ? round1(derivedTotal / direct) : null
          }
        : null
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

export const requestCostTap: TrafficTap = {
  id: REQUEST_COST_TAP,
  onRequest(c) {
    const m = requestMeasure(c.ev.req)
    if (!m) return
    const e = entityOf(c.entityKey)
    if (!e) return
    const sec = c.sec
    const s = e.slots
    const split = splitLatency({
      total: c.ev.latencyMs,
      sql: m.sqlOutsideMs,
      auth: m.authMs,
      meta: m.metadataMs,
      hooks: m.hooksMs,
      ser: m.serializationMs
    })
    s.add(sec, S.n, 1)
    s.add(sec, S.queries, m.queries)
    s.add(sec, S.sql, split.sql)
    s.add(sec, S.auth, split.auth)
    s.add(sec, S.meta, split.meta)
    s.add(sec, S.hooks, split.hooks)
    s.add(sec, S.ser, split.ser)
    s.add(sec, S.total, Math.max(0, c.ev.latencyMs))
    s.add(sec, S.db, Math.min(Math.max(0, c.ev.latencyMs), m.sqlMs))
    if (m.accessMs > 0) {
      s.add(sec, S.access, m.accessMs)
      s.add(sec, S.accessN, 1)
    }
    if (m.repeatN >= REPEAT_SHAPE_MIN) {
      s.add(sec, S.repeatReq, 1)
      // Keep the worst shape of the last five minutes (a fresh one replaces a stale one).
      if (m.repeatN >= e.repeatN || e.slots.sum(300, sec)[S.repeatReq] <= 1) {
        e.repeatN = m.repeatN
        e.repeatSql = m.repeatSql ? m.repeatSql.slice(0, SQL_TEXT_CAP) : null
      }
    }
    const d = m.derived
    if (d) {
      if (d[0] > 0) s.add(sec, S.writeReq, 1)
      for (let i = 0; i < DERIVED_LABELS.length; i++) s.add(sec, S.derived + i, d[i] ?? 0)
    }
  },
  onWrite() {
    // A write inside a request counts as that request's direct write (amplification's base);
    // the items service's broadcast runs inside the request, so the trace context is there.
    noteDerivedWrite('direct')
  },
  frame(sec) {
    // Live figures for the badge + hot-table column: avg round trips over the last minute of
    // every entity that ran a measured request, and which of them cross the N+1 threshold.
    const trips: Record<string, number> = {}
    const n1: string[] = []
    let any = false
    for (const key of state().entities.keys()) {
      const sum = costSummary(key, 60, sec)
      if (!sum) continue
      trips[key] = sum.avg_trips
      if (sum.n_plus_one) n1.push(key)
      any = true
    }
    return any ? { trips, n1, threshold: N_PLUS_ONE_AVG_TRIPS } : undefined
  },
  entitySnapshot(key, windowS, sec) {
    return costSummary(key, windowS, sec) ?? undefined
  },
  entityDetail(key, windowS, sec) {
    return costDetail(key, windowS, sec) ?? undefined
  },
  sweep(sec) {
    const map = state().entities
    for (const [k, e] of map) if (e.slots.idle(sec)) map.delete(k)
  }
}

registerTrafficTap(requestCostTap)
