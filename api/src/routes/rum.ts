import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { parseBrowser, screenClass } from '../services/traffic-inspect/people-ux-logic.js'

/**
 * Real-user monitoring intake + summary. Intake accepts small batches from
 * the browser collector (authenticated — RUM is an internal console, not a
 * public beacon endpoint); the summary powers the /api-analytics section.
 */

const MAX_EVENTS = 20
/** Widget rows (#1353) ride existing columns — no migration. route = `widget:<catalog key>@<ROLE UUID>`
 *  (`@-` with no role), ttfb_ms = fetch, fcp_ms = paint, duration_ms = fetch + paint. */
const WIDGET_KEY = /^[A-Za-z0-9._:-]{1,80}$/
const ROLE_ID = /^[0-9A-F-]{36}$/
const widgetRoute = (e: Record<string, unknown>): string | null => {
  if (typeof e.widget !== 'string' || !WIDGET_KEY.test(e.widget)) return null
  const role =
    typeof e.role === 'string' && ROLE_ID.test(e.role.toUpperCase()) ? e.role.toUpperCase() : '-'
  return `widget:${e.widget}@${role}`
}
const NUM = (v: unknown, cap = 600_000): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= cap ? Math.round(n) : null
}

export async function rumRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', { preHandler: requireAuth }, async (req) => {
    const b = req.body as { events?: Array<Record<string, unknown>> }
    const events = (Array.isArray(b?.events) ? b.events : []).slice(0, MAX_EVENTS)
    // #2191 — browser, OS and a width class ride each row (migration 453; skipped until it lands).
    const device = (await hasColumn('nivaro_rum_events', 'browser'))
      ? parseBrowser(req.headers['user-agent'])
      : null
    const rows = events
      .filter(
        (e) =>
          (e.kind === 'widget' && widgetRoute(e) !== null && NUM(e.fetch_ms) !== null) ||
          (typeof e.route === 'string' &&
            (e.kind === 'load' || e.kind === 'route' || e.kind === 'rage' || e.kind === 'dead'))
      )
      .map((e) => {
        if (e.kind !== 'widget') return e
        const fetch = NUM(e.fetch_ms) ?? 0
        const paint = NUM(e.paint_ms) ?? 0
        return {
          ...e,
          route: widgetRoute(e) as string,
          ttfb_ms: fetch,
          fcp_ms: paint,
          lcp_ms: null,
          duration_ms: fetch + paint
        }
      })
      .map((e) => ({
        route: String(e.route).slice(0, 300),
        kind: e.kind,
        ttfb_ms: NUM(e.ttfb_ms),
        fcp_ms: NUM(e.fcp_ms),
        lcp_ms: NUM(e.lcp_ms),
        duration_ms: NUM(e.duration_ms),
        app: typeof e.app === 'string' ? e.app.slice(0, 100) : null,
        user: req.user?.id ?? null,
        created_at: new Date(),
        ...(device
          ? {
              browser: device.browser.slice(0, 40),
              os: device.os.slice(0, 30),
              screen: screenClass(e.vw)
            }
          : {})
      }))
    if (rows.length > 0)
      await db('nivaro_rum_events')
        .insert(rows)
        .catch(() => {})
    // #1371 — a rage click or a dead-click burst asks this person's browser
    // to record the next three minutes (when replay_auto_signals is on).
    const frustrated = rows.find((r) => r.kind === 'rage') ?? rows.find((r) => r.kind === 'dead')
    if (frustrated && req.user?.id) {
      const { fireReplaySignal } = await import('../services/replay-auto-signals.js')
      void fireReplaySignal(frustrated.kind === 'rage' ? 'rage-click' : 'dead-click', {
        userIds: [req.user.id]
      })
    }
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
      .whereNot('kind', 'widget')
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
  })

  /** Slowest dashboard widgets (#1353): p75 fetch / paint / total per catalog key, for one role
   *  (`?role=<uuid>`) or across all, over `days` (default 7, max 14). Counts only; no people. */
  app.get('/widgets', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { role?: string; days?: string; limit?: string }
    const days = Math.min(14, Math.max(1, Number(q.days) || 7))
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10))
    const role =
      typeof q.role === 'string' && ROLE_ID.test(q.role.toUpperCase()) ? q.role.toUpperCase() : null
    const since = new Date(Date.now() - days * 86_400_000)
    const qb = db('nivaro_rum_events')
      .where('kind', 'widget')
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(20_000)
      .select('route', 'ttfb_ms', 'fcp_ms', 'duration_ms')
    if (role) qb.whereRaw("route LIKE ? ESCAPE '\\'", [`widget:%@${role}`])
    const rows = (await qb) as Array<{
      route: string
      ttfb_ms: number | null
      fcp_ms: number | null
      duration_ms: number | null
    }>
    return { data: summarizeWidgets(rows, limit), days, role, total_events: rows.length }
  })
}

type WidgetRow = {
  route: string
  ttfb_ms: number | null
  fcp_ms: number | null
  duration_ms: number | null
}

const p75Of = (vals: number[]): number | null => {
  if (vals.length === 0) return null
  const sorted = [...vals].sort((a, z) => a - z)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]
}

/** Group widget rows by catalog key and rank by p75 total (fetch + paint), slowest first. */
export function summarizeWidgets(rows: WidgetRow[], limit = 10) {
  const by = new Map<string, { fetch: number[]; paint: number[]; total: number[] }>()
  for (const r of rows) {
    const m = /^widget:(.+)@[^@]*$/.exec(r.route)
    if (!m) continue
    const b = by.get(m[1]) ?? { fetch: [], paint: [], total: [] }
    if (r.ttfb_ms != null) b.fetch.push(r.ttfb_ms)
    if (r.fcp_ms != null) b.paint.push(r.fcp_ms)
    if (r.duration_ms != null) b.total.push(r.duration_ms)
    by.set(m[1], b)
  }
  return [...by.entries()]
    .map(([key, b]) => ({
      key,
      samples: b.total.length,
      fetch_p75: p75Of(b.fetch),
      paint_p75: p75Of(b.paint),
      total_p75: p75Of(b.total)
    }))
    .sort((a, z) => (z.total_p75 ?? 0) - (a.total_p75 ?? 0))
    .slice(0, limit)
}
