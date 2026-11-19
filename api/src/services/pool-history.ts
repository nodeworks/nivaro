import { localSnapshot, type NodeSnapshot } from './pool-holders.js'
import { accessLogEnabled } from './telemetry-store.js'

/**
 * Connection history for Grafana (2026-11-18). The Connections tab (pool-holders.ts) shows who
 * holds database connections right now and forgets it; these two outputs keep it:
 *
 *  - metrics: `nivaro_db_pool_held{pool,feature}` — connections held or waited for, per feature
 *    (route template / job), the busiest 15 per pool and the rest as "other", so the number of
 *    series stays small (plugins/metrics.ts, scraped every 30 s);
 *  - one log line every 10 s (`nvr: "pool"`) while anything is held or waiting, with the top
 *    holders by person (the caller key — user / API key / MCP id, never a name or email) and by
 *    feature. It rides the access-log stream to the long-history log store
 *    (TELEMETRY_ACCESS_LOG=on), so "who held connections at 2:25 PM" is one query there.
 */

export const FEATURE_TOP = 15
const PERSON_TOP = 8
export const HISTORY_EVERY_MS = 10_000

export interface FeatureHeld {
  pool: string
  feature: string
  held: number
  waiting: number
}

function rankCounts(entries: Iterable<[string, number]>, top: number): Array<[string, number]> {
  const sorted = [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (sorted.length <= top) return sorted
  const rest = sorted.slice(top).reduce((s, [, n]) => s + n, 0)
  return [...sorted.slice(0, top), ['other', rest]]
}

/** Connections held and waited for per pool + feature: the busiest `top`, the rest as "other". */
export function heldByFeature(s: NodeSnapshot, top = FEATURE_TOP): FeatureHeld[] {
  const out: FeatureHeld[] = []
  const pools = new Set(s.rows.map((r) => r.pool))
  for (const pool of pools) {
    const held = new Map<string, number>()
    const waiting = new Map<string, number>()
    for (const r of s.rows) {
      if (r.pool !== pool) continue
      const f = r.feature.label || r.feature.key || 'unlabelled'
      const m = r.state === 'holding' ? held : waiting
      m.set(f, (m.get(f) ?? 0) + 1)
    }
    const totals = new Map<string, number>()
    for (const [k, n] of held) totals.set(k, n)
    for (const [k, n] of waiting) totals.set(k, (totals.get(k) ?? 0) + n)
    const kept = new Set(
      rankCounts(totals, top)
        .map(([k]) => k)
        .filter((k) => k !== 'other')
    )
    const acc = new Map<string, FeatureHeld>()
    for (const [k] of totals) {
      const name = kept.has(k) ? k : 'other'
      const row = acc.get(name) ?? { pool, feature: name, held: 0, waiting: 0 }
      row.held += held.get(k) ?? 0
      row.waiting += waiting.get(k) ?? 0
      acc.set(name, row)
    }
    out.push(...acc.values())
  }
  return out
}

/** The 10 s history line, or null when nothing is held or waiting (no noise when idle). */
export function poolHistoryLine(s: NodeSnapshot): Record<string, string | number> | null {
  const main = s.pools.find((p) => p.name === 'main')
  const bg = s.pools.find((p) => p.name === 'background')
  if (s.rows.length === 0 && !main?.used && !bg?.used) return null
  const people = new Map<string, number>()
  const features = new Map<string, number>()
  for (const r of s.rows) {
    const who = r.person.key || r.person.kind
    people.set(who, (people.get(who) ?? 0) + 1)
    const f = `${r.pool === 'background' ? 'bg:' : ''}${r.feature.label || r.feature.key}`
    features.set(f, (features.get(f) ?? 0) + 1)
  }
  const join = (xs: Array<[string, number]>) => xs.map(([k, n]) => `${k}=${n}`).join('; ')
  return {
    nvr: 'pool',
    inst: s.node,
    role: s.role ?? 'all',
    used: main?.used ?? 0,
    max: main?.max ?? 0,
    pending: main?.pending_acquires ?? 0,
    bg_used: bg?.used ?? 0,
    bg_max: bg?.max ?? 0,
    bg_pending: bg?.pending_acquires ?? 0,
    gate_active: s.read_gate.active,
    gate_queued: s.read_gate.queued,
    people: join(rankCounts(people, PERSON_TOP)),
    features: join(rankCounts(features, FEATURE_TOP))
  }
}

/** Starts the 10 s history line on this process (only where the access log is on). */
export function startPoolHistory(log: { info: (obj: object, msg: string) => void }): () => void {
  if (!accessLogEnabled()) return () => {}
  const timer = setInterval(() => {
    try {
      const line = poolHistoryLine(localSnapshot())
      if (line) log.info(line, 'pool')
    } catch {
      /* history never takes the process down */
    }
  }, HISTORY_EVERY_MS)
  timer.unref()
  return () => clearInterval(timer)
}
