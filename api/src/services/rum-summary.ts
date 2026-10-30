import { db } from '../db/index.js'

/**
 * Per-route RUM p75s for a window — the /api/rum/summary answer (the API analytics page) and the
 * Overview's "slowest page this week". p75 via a JS pass over per-route samples: routes are few,
 * rows are capped by retention, and PERCENTILE_CONT per group is dialect pain a dashboard does
 * not need.
 */

export interface RumRouteSummary {
  route: string
  samples: number
  load_p75: number | null
  lcp_p75: number | null
  route_p75: number | null
}

export interface RumSummary {
  rage: Array<{ target: string; bursts: number }>
  data: RumRouteSummary[]
  total_events: number
}

export interface RumRow {
  route: string
  kind: string
  lcp_ms: number | null
  duration_ms: number | null
  app: string | null
}

const p75 = (vals: number[]): number | null => {
  if (vals.length === 0) return null
  const sorted = [...vals].sort((a, z) => a - z)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]
}

/** Pure: rows → the summary (slowest first). */
export function summarizeRum(rows: RumRow[]): RumSummary {
  // Rage clicks (#409): the frustration signal aggregated per target.
  const rageByTarget = new Map<string, number>()
  const byRoute = new Map<string, { loads: number[]; lcps: number[]; routes: number[] }>()
  for (const r of rows) {
    if (r.kind === 'rage') {
      rageByTarget.set(r.route, (rageByTarget.get(r.route) ?? 0) + 1)
      continue
    }
    const key = `${r.app ?? 'admin'} ${r.route}`
    const b = byRoute.get(key) ?? { loads: [], lcps: [], routes: [] }
    if (r.kind === 'load') {
      if (r.duration_ms != null) b.loads.push(r.duration_ms)
      if (r.lcp_ms != null) b.lcps.push(r.lcp_ms)
    } else if (r.duration_ms != null) {
      b.routes.push(r.duration_ms)
    }
    byRoute.set(key, b)
  }
  const data = [...byRoute.entries()]
    .map(([key, b]) => ({
      route: key,
      samples: b.loads.length + b.routes.length,
      load_p75: p75(b.loads),
      lcp_p75: p75(b.lcps),
      route_p75: p75(b.routes)
    }))
    .sort((a, z) => (z.lcp_p75 ?? z.route_p75 ?? 0) - (a.lcp_p75 ?? a.route_p75 ?? 0))
  const rage = [...rageByTarget.entries()]
    .map(([target, bursts]) => ({ target, bursts }))
    .sort((a, z) => z.bursts - a.bursts)
    .slice(0, 25)
  return { rage, data, total_events: rows.length }
}

/** The summary for the last `days` (1–14). */
export async function rumSummary(days: number): Promise<RumSummary> {
  const d = Math.min(14, Math.max(1, Math.floor(days) || 1))
  const since = new Date(Date.now() - d * 86_400_000)
  const rows = (await db('nivaro_rum_events')
    .where('created_at', '>=', since)
    .whereNot('kind', 'widget')
    .select('route', 'kind', 'lcp_ms', 'duration_ms', 'app')) as RumRow[]
  return summarizeRum(rows)
}
