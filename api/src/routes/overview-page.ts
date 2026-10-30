import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import {
  isAppPath,
  normalizeLayout,
  normalizePinnedActions,
  normalizePinnedWidgets,
  normalizeRoleDefaults,
  parseDayStart,
  rollVisit
} from '../services/overview/model.js'
import {
  readOverviewPrefs,
  readRoleDefaults,
  roleDefaultFor,
  writeOverviewPrefs,
  writeRoleDefaults
} from '../services/overview/prefs.js'
import { computeOverviewStats, computeSinceDigest, memo } from '../services/overview/stats.js'
import { sharedGatedRead } from '../services/read-gate.js'
import type { User } from '../types.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * The admin Overview page (route `/`):
 *
 *   GET  /overview/stats?day_start=<ISO>  figures with a comparison + 24 hourly bars, as the viewer
 *   GET  /overview/since                  "since your last visit" digest, as the viewer
 *   POST /overview/visit                  roll the last-visit watermark (30-minute sitting grace)
 *   GET  /overview/prefs                  own layout, pinned quick actions + widgets, role starter
 *   PUT  /overview/prefs                  change any of them (layout null = back to the role's)
 *   GET  /overview/my-routes                own most-opened admin screens, last 30 days (RUM)
 *   GET  /overview/pinned-widgets         own pinned dashboard widgets the caller may still read
 *   GET  /overview/role-defaults          admin: every role's starter layout
 *   PUT  /overview/role-defaults          admin: replace them
 *
 * Everything answers for the caller only; nothing here reads another person's preferences.
 */

const viewer = (req: FastifyRequest) => req.user as User

export async function overviewPageRoutes(app: FastifyInstance) {
  app.get('/stats', { preHandler: requireAuth }, async (req) => {
    const user = viewer(req)
    const isAdmin = !!req.isAdmin && !user.api_key_scopes
    const now = new Date()
    const dayStart = parseDayStart((req.query as { day_start?: string }).day_start, now)
    // Administrators share one answer per day start; everyone else gets their own.
    const who = isAdmin ? 'admin' : `u:${user.id}`
    const key = `overview-stats|${who}|${dayStart.toISOString()}`
    const data = await memo(key, async () => {
      const { value } = await sharedGatedRead(
        key,
        String(user.id),
        () => computeOverviewStats(user, { isAdmin, dayStart, now }),
        { label: 'overview-stats' }
      )
      return value
    })
    return { data }
  })

  app.get('/since', { preHandler: requireAuth }, async (req) => {
    const user = viewer(req)
    const isAdmin = !!req.isAdmin && !user.api_key_scopes
    const prefs = await readOverviewPrefs(String(user.id))
    const since = prefs.prev_visit_at ? new Date(prefs.prev_visit_at) : null
    if (!since) return { data: null }
    const key = `overview-since|${isAdmin ? 'a' : 'u'}:${user.id}|${since.toISOString()}`
    const digest = await memo(
      key,
      async () => {
        const { value } = await sharedGatedRead(
          key,
          String(user.id),
          () => computeSinceDigest(user, { isAdmin, since }),
          { label: 'overview-since' }
        )
        return value
      },
      60_000
    )
    const release =
      prefs.prev_visit_version && prefs.prev_visit_version !== NIVARO_VERSION
        ? { from: prefs.prev_visit_version, to: NIVARO_VERSION }
        : null
    return { data: { ...digest, release } }
  })

  app.post('/visit', { preHandler: requireAuth }, async (req) => {
    const user = viewer(req)
    const next = await writeOverviewPrefs(String(user.id), (p) =>
      rollVisit(p, new Date(), NIVARO_VERSION)
    )
    return { data: { last_visit_at: next.last_visit_at, prev_visit_at: next.prev_visit_at } }
  })

  app.get('/prefs', { preHandler: requireAuth }, async (req) => {
    const user = viewer(req)
    const [prefs, roleDefault] = await Promise.all([
      readOverviewPrefs(String(user.id)),
      roleDefaultFor(user.role).catch(() => null)
    ])
    return { data: { ...prefs, role_default: roleDefault } }
  })

  app.put('/prefs', { preHandler: requireAuth }, async (req, reply) => {
    const user = viewer(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const known = ['layout', 'pinned_actions', 'dismissed_actions', 'pinned_widgets']
    if (!known.some((k) => k in body)) {
      return reply.code(400).send({ error: `Send one of: ${known.join(', ')}` })
    }
    if ('layout' in body && body.layout !== null && !normalizeLayout(body.layout)) {
      return reply.code(400).send({ error: 'layout must be {order, hidden, shown} or null' })
    }
    const next = await writeOverviewPrefs(String(user.id), (p) => ({
      ...p,
      ...('layout' in body
        ? { layout: body.layout === null ? null : normalizeLayout(body.layout) }
        : {}),
      ...('pinned_actions' in body
        ? { pinned_actions: normalizePinnedActions(body.pinned_actions) }
        : {}),
      ...('dismissed_actions' in body
        ? {
            dismissed_actions: (Array.isArray(body.dismissed_actions) ? body.dismissed_actions : [])
              .filter(isAppPath)
              .slice(0, 30)
          }
        : {}),
      ...('pinned_widgets' in body
        ? { pinned_widgets: normalizePinnedWidgets(body.pinned_widgets) }
        : {})
    }))
    return { data: next }
  })

  app.get('/my-routes', { preHandler: requireAuth }, async (req) => {
    const user = viewer(req)
    // One read per person per 10 minutes: page loads are many and the answer moves slowly.
    const data = await memo(
      `overview-usage|${user.id}`,
      async () => {
        const since = new Date(Date.now() - 30 * 86_400_000)
        const rows = (await db('nivaro_rum_events')
          .where({ user: user.id, app: 'admin' })
          .whereIn('kind', ['load', 'route'])
          .where('created_at', '>=', since)
          .groupBy('route')
          .select('route')
          .count({ n: '*' })
          .orderBy('n', 'desc')
          .limit(40)
          .catch(() => [])) as Array<{ route: string; n: number | string }>
        // Patterns with a placeholder (/collections/:c/:id) are not a screen anyone can open.
        return rows
          .filter((r) => isAppPath(r.route) && !r.route.includes(':') && r.route !== '/')
          .map((r) => ({ path: r.route, opens: Number(r.n) || 0 }))
          .slice(0, 20)
      },
      10 * 60_000
    )
    return { data }
  })

  app.get('/pinned-widgets', { preHandler: requireAuth }, async (req) => {
    const user = viewer(req)
    const prefs = await readOverviewPrefs(String(user.id))
    if (prefs.pinned_widgets.length === 0) return { data: [] }
    const widgets = (await db('nivaro_dashboard_widgets')
      .whereIn('id', prefs.pinned_widgets)
      .select('*')
      .catch(() => [])) as Array<Record<string, unknown>>
    const dashIds = [...new Set(widgets.map((w) => String(w.dashboard)))]
    const dashboards = dashIds.length
      ? ((await db('nivaro_dashboards')
          .whereIn('id', dashIds)
          .select('id', 'name', 'user', 'is_shared', 'role_id')) as Array<Record<string, unknown>>)
      : []
    const byId = new Map(dashboards.map((d) => [String(d.id), d]))
    const role = user.role ? String(user.role).toUpperCase() : null
    // The same rule as GET /dashboards: own, or shared with everyone / the caller's role.
    const canSee = (d: Record<string, unknown> | undefined) =>
      !!d &&
      (!!req.isAdmin ||
        String(d.user).toUpperCase() === String(user.id).toUpperCase() ||
        (!!d.is_shared && (!d.role_id || String(d.role_id).toUpperCase() === role)))
    const parse = (v: unknown) => {
      if (typeof v !== 'string') return v ?? null
      try {
        return JSON.parse(v)
      } catch {
        return null
      }
    }
    const order = new Map(prefs.pinned_widgets.map((id, i) => [id, i]))
    const data = widgets
      .filter((w) => canSee(byId.get(String(w.dashboard))))
      .map(
        (w): Record<string, unknown> => ({
          ...w,
          filters: parse(w.filters),
          is_shared: undefined,
          dashboard_name: String(byId.get(String(w.dashboard))?.name ?? '')
        })
      )
      .sort((a, b) => (order.get(String(a.id)) ?? 99) - (order.get(String(b.id)) ?? 99))
    return { data }
  })

  app.get('/role-defaults', { preHandler: requireAdmin }, async () => {
    return { data: await readRoleDefaults() }
  })

  app.put('/role-defaults', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { defaults?: unknown }
    const map = normalizeRoleDefaults(body.defaults ?? {})
    const ok = await writeRoleDefaults(map)
    if (!ok) {
      return reply
        .code(409)
        .send({ error: 'Role starter layouts need migration 522 (restart the API to run it).' })
    }
    return { data: map }
  })
}
