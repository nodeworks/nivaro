import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'

/**
 * Real-user monitoring intake + summary. Intake accepts small batches from
 * the browser collector (authenticated — RUM is an internal console, not a
 * public beacon endpoint); the summary powers the /api-analytics section.
 */

const MAX_EVENTS = 20
const NUM = (v: unknown, cap = 600_000): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= cap ? Math.round(n) : null
}

export async function rumRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', { preHandler: requireAuth }, async (req) => {
    const b = req.body as { events?: Array<Record<string, unknown>> }
    const events = (Array.isArray(b?.events) ? b.events : []).slice(0, MAX_EVENTS)
    const rows = events
      .filter((e) => typeof e.route === 'string' && (e.kind === 'load' || e.kind === 'route'))
      .map((e) => ({
        route: String(e.route).slice(0, 300),
        kind: e.kind,
        ttfb_ms: NUM(e.ttfb_ms),
        fcp_ms: NUM(e.fcp_ms),
        lcp_ms: NUM(e.lcp_ms),
        duration_ms: NUM(e.duration_ms),
        app: typeof e.app === 'string' ? e.app.slice(0, 100) : null,
        user: req.user?.id ?? null,
        created_at: new Date()
      }))
    if (rows.length > 0) await db('nivaro_rum_events').insert(rows).catch(() => {})
    return { data: { accepted: rows.length } }
  })

  /** Per-route p75s for a window. p75 via a JS pass over per-route samples —
   *  routes are few, rows are capped by retention, and PERCENTILE_CONT per
   *  group is dialect pain we don't need for a dashboard. */
  app.get('/summary', { preHandler: requireAdmin }, async (req) => {
    const days = Math.min(14, Math.max(1, Number((req.query as { days?: string }).days) || 1))
    const since = new Date(Date.now() - days * 86_400_000)
    const rows = (await db('nivaro_rum_events')
      .where('created_at', '>=', since)
      .select('route', 'kind', 'lcp_ms', 'duration_ms', 'app')) as Array<{
      route: string
      kind: string
      lcp_ms: number | null
      duration_ms: number | null
      app: string | null
    }>

    const p75 = (vals: number[]): number | null => {
      if (vals.length === 0) return null
      const sorted = [...vals].sort((a, z) => a - z)
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]
    }

    const byRoute = new Map<string, { loads: number[]; lcps: number[]; routes: number[] }>()
    for (const r of rows) {
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
    return { data, total_events: rows.length }
  })
}
