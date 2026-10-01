// api/src/services/traffic-taps/caller-cost.ts
/**
 * Traffic Map: what a caller costs (#1122) — per key or person, per hour: requests, errors,
 * database time (the summed duration of every statement its requests ran), round trips, rows the
 * database handed back, and AI spend (`nivaro_ai_calls.cost_usd`).
 *
 * The SQL figures come from the in-flight tracker (services/traffic-inflight.ts), which times
 * each statement a request runs and stamps the totals on the request when it ends. Kept in
 * memory for the last HOURS hours of THIS process; AI spend is read from the AI call log, which
 * records the person (a key's calls are its owner's — the log carries no key).
 */
import { db } from '../../db/index.js'
import { requestSqlStats } from '../traffic-inflight.js'
import { currentTrafficSec } from '../traffic-map.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'

export const TAP_ID = 'caller-cost'
export const HOURS = 24
const CALLER_CAP = 300

export interface HourCost {
  req: number
  error: number
  /** Summed response time, ms. */
  ms: number
  db_ms: number
  queries: number
  rows: number
}
interface CallerCost {
  hours: Map<number, HourCost>
  last: number
}
interface State {
  callers: Map<string, CallerCost>
}
function state(): State {
  return tapState<State>(TAP_ID, () => ({ callers: new Map() }))
}

const empty = (): HourCost => ({ req: 0, error: 0, ms: 0, db_ms: 0, queries: 0, rows: 0 })

/** Add one finished request to a caller's hour (pure on the given state; exported for tests). */
export function addCost(
  s: State,
  caller: string,
  sec: number,
  v: { error: boolean; ms: number; db_ms: number; queries: number; rows: number }
): void {
  let c = s.callers.get(caller)
  if (!c) {
    if (s.callers.size >= CALLER_CAP) {
      let stale: string | null = null
      let staleAt = Number.POSITIVE_INFINITY
      for (const [k, x] of s.callers) {
        if (x.last < staleAt) {
          staleAt = x.last
          stale = k
        }
      }
      if (stale) s.callers.delete(stale)
    }
    c = { hours: new Map(), last: sec }
    s.callers.set(caller, c)
  }
  c.last = sec
  const h = Math.floor(sec / 3600)
  let row = c.hours.get(h)
  if (!row) {
    row = empty()
    c.hours.set(h, row)
    for (const k of c.hours.keys()) if (k <= h - HOURS) c.hours.delete(k)
  }
  row.req++
  if (v.error) row.error++
  row.ms += v.ms
  row.db_ms += v.db_ms
  row.queries += v.queries
  row.rows += v.rows
}

registerTrafficTap({
  id: TAP_ID,
  onRequest: (c) => {
    const sql = requestSqlStats(c.ev.req)
    addCost(state(), c.caller, c.sec, {
      error: c.isError,
      ms: c.ev.latencyMs,
      db_ms: sql?.sql_ms ?? 0,
      queries: sql?.queries ?? 0,
      rows: sql?.rows ?? 0
    })
  },
  sweep: (sec) => {
    const s = state()
    const h = Math.floor(sec / 3600)
    for (const [k, c] of s.callers) {
      for (const hk of c.hours.keys()) if (hk <= h - HOURS) c.hours.delete(hk)
      if (!c.hours.size) s.callers.delete(k)
    }
  }
})

export interface CallerCostReport {
  key: string
  hours: Array<HourCost & { hour: string; ai_usd: number; ai_calls: number }>
  totals: HourCost & { ai_usd: number; ai_calls: number }
  /** Why AI spend is (not) shown for this caller. */
  ai_note: string | null
  since_process_start: string
}

const CALLER_RE = /^(k\d{1,12}|u[0-9A-F-]{36}|cron|anon)$/

export function validCallerKey(key: string): boolean {
  return CALLER_RE.test(key)
}

/** Hourly figures for one caller, newest hour first, AI spend joined from the AI call log. */
export async function callerCost(
  key: string,
  sec = currentTrafficSec(),
  bootedAtMs = Date.now() - Math.round(process.uptime() * 1000)
): Promise<CallerCostReport> {
  const c = state().callers.get(key)
  const nowH = Math.floor(sec / 3600)
  const ai = new Map<number, { usd: number; n: number }>()
  let aiNote: string | null = null
  if (key.startsWith('u')) {
    try {
      const since = new Date((nowH - HOURS + 1) * 3600_000)
      const rows = (await db('nivaro_ai_calls')
        .where('user', key.slice(1))
        .where('created_at', '>=', since)
        .select('created_at', 'cost_usd')
        .limit(20_000)) as Array<{ created_at: Date | string; cost_usd: number | string | null }>
      for (const r of rows) {
        const h = Math.floor(new Date(r.created_at).getTime() / 3_600_000)
        const v = ai.get(h) ?? { usd: 0, n: 0 }
        v.usd += Number(r.cost_usd) || 0
        v.n++
        ai.set(h, v)
      }
    } catch {
      aiNote = 'The AI call log could not be read right now.'
    }
  } else if (key.startsWith('k')) {
    aiNote = 'AI calls are logged against people; a key’s calls count under its owner.'
  }
  const hours: CallerCostReport['hours'] = []
  const totals = { ...empty(), ai_usd: 0, ai_calls: 0 }
  for (let h = nowH; h > nowH - HOURS; h--) {
    const row = c?.hours.get(h) ?? empty()
    const a = ai.get(h) ?? { usd: 0, n: 0 }
    if (row.req === 0 && a.n === 0) continue
    const out = {
      hour: new Date(h * 3_600_000).toISOString(),
      ...row,
      ms: Math.round(row.ms),
      db_ms: Math.round(row.db_ms),
      ai_usd: Math.round(a.usd * 10_000) / 10_000,
      ai_calls: a.n
    }
    hours.push(out)
    totals.req += row.req
    totals.error += row.error
    totals.ms += row.ms
    totals.db_ms += row.db_ms
    totals.queries += row.queries
    totals.rows += row.rows
    totals.ai_usd += a.usd
    totals.ai_calls += a.n
  }
  totals.ms = Math.round(totals.ms)
  totals.db_ms = Math.round(totals.db_ms)
  totals.ai_usd = Math.round(totals.ai_usd * 10_000) / 10_000
  return {
    key,
    hours,
    totals,
    ai_note: aiNote,
    since_process_start: new Date(bootedAtMs).toISOString()
  }
}
