import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { computeWidgetData } from '../services/dashboard-widgets.js'

/**
 * Public dashboard share links.
 *
 * Owner (or admin) mints a token URL for a dashboard; anyone with the link
 * sees a read-only render. Widget data resolves server-side with no viewer to
 * permission-check — same "creator configured it, served to every viewer"
 * model as widget feeds and record share links. Curation-not-security.
 */

interface LinkRow {
  id: number
  dashboard: string
  token: string
  expires_at: Date | null
  is_active: boolean
  view_count: number
  created_by: string | null
}

async function ownedDashboard(
  req: { user?: { id: string } | null; isAdmin?: boolean },
  dashboardId: string
): Promise<{ error: 404 | 403 } | { error?: undefined; dash: { id: string; user: string; name: string } }> {
  const dash = (await db('nivaro_dashboards').where({ id: dashboardId }).first()) as
    | { id: string; user: string; name: string }
    | undefined
  if (!dash) return { error: 404 }
  if (!req.isAdmin && dash.user !== req.user?.id) return { error: 403 }
  return { dash }
}

export async function dashboardLinkRoutes(app: FastifyInstance) {
  app.post<{ Body: { dashboard_id?: string; expires_in_days?: number | null } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { dashboard_id, expires_in_days } = req.body ?? {}
      if (!dashboard_id) return reply.code(400).send({ error: 'dashboard_id is required' })
      const owned = await ownedDashboard(req, dashboard_id)
      if (owned.error) {
        return reply
          .code(owned.error)
          .send({ error: owned.error === 404 ? 'Dashboard not found' : 'Forbidden' })
      }

      const token = randomBytes(24).toString('hex')
      const expiresAt =
        expires_in_days && expires_in_days > 0
          ? new Date(Date.now() + expires_in_days * 86_400_000)
          : null
      const [row] = await db('nivaro_dashboard_links')
        .insert({
          dashboard: dashboard_id,
          token,
          expires_at: expiresAt,
          is_active: true,
          created_by: req.user!.id,
          created_at: new Date()
        })
        .returning('id')
      const id = typeof row === 'object' ? (row as { id: number }).id : row

      await logActivity({
        action: 'dashboard-link-create',
        collection: 'nivaro_dashboards',
        item: dashboard_id,
        user: req.user!.id,
        comment: `Public link ${id}${expiresAt ? ` expires ${expiresAt.toISOString()}` : ''}`
      })

      return reply.send({ data: { id, token, url: `/d/${token}`, expires_at: expiresAt } })
    }
  )

  app.get<{ Params: { dashboardId: string } }>(
    '/for/:dashboardId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const owned = await ownedDashboard(req, req.params.dashboardId)
      if (owned.error) {
        return reply
          .code(owned.error)
          .send({ error: owned.error === 404 ? 'Dashboard not found' : 'Forbidden' })
      }
      const rows = (await db('nivaro_dashboard_links')
        .where({ dashboard: req.params.dashboardId })
        .orderBy('created_at', 'desc')) as LinkRow[]
      return reply.send({
        data: rows.map((r) => ({
          id: r.id,
          token: r.token,
          url: `/d/${r.token}`,
          expires_at: r.expires_at,
          is_active: r.is_active,
          view_count: r.view_count
        }))
      })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = (await db('nivaro_dashboard_links')
        .where({ id: Number(req.params.id) })
        .first()) as LinkRow | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const owned = await ownedDashboard(req, row.dashboard)
      if (owned.error) return reply.code(403).send({ error: 'Forbidden' })
      await db('nivaro_dashboard_links').where({ id: row.id }).del()
      await logActivity({
        action: 'dashboard-link-revoke',
        collection: 'nivaro_dashboards',
        item: row.dashboard,
        user: req.user!.id,
        comment: `Public link ${row.id} revoked`
      })
      return reply.send({ data: { revoked: true } })
    }
  )

  // ── Public renderer feed — no auth ─────────────────────────────────────────
  app.get<{ Params: { token: string } }>('/public/:token', async (req, reply) => {
    const token = req.params.token
    if (!/^[a-f0-9]{48}$/.test(token)) return reply.code(404).send({ error: 'Not found' })
    const link = (await db('nivaro_dashboard_links').where({ token }).first()) as
      | LinkRow
      | undefined
    if (!link || !link.is_active) return reply.code(404).send({ error: 'Not found' })
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      return reply.code(410).send({ error: 'This link has expired' })
    }

    const dashboard = (await db('nivaro_dashboards').where({ id: link.dashboard }).first()) as
      | { id: string; name: string }
      | undefined
    if (!dashboard) return reply.code(404).send({ error: 'Not found' })

    const widgets = (await db('nivaro_dashboard_widgets')
      .where({ dashboard: dashboard.id })
      .orderBy('row')
      .orderBy('col')) as Array<{
      id: string
      type: string
      title: string | null
      collection: string | null
      field: string | null
      col: number
      row: number
      width: number
      height: number
    }>

    const resolved = await Promise.all(
      widgets.map(async (w) => {
        const result = await computeWidgetData(w)
        return {
          id: w.id,
          type: w.type,
          title: w.title,
          col: w.col,
          row: w.row,
          width: w.width,
          height: w.height,
          data: 'data' in result ? result.data : null
        }
      })
    )

    // fire-and-forget view count
    void db('nivaro_dashboard_links')
      .where({ id: link.id })
      .increment('view_count', 1)
      .catch(() => {})

    return reply.send({ data: { name: dashboard.name, widgets: resolved } })
  })
}
