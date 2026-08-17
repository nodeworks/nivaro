import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'

/**
 * Own-CRUD for saved-view subscriptions (see services/view-subscriptions.ts
 * for what a subscription actually does). Deliberately mirrors the
 * notification-subscriptions posture: any authenticated user manages their
 * OWN rows; visibility of the underlying view is checked at subscribe time
 * the same way the saved-views list is scoped (own, shared, or role-shared).
 */
export async function viewSubscriptionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/', async (req, reply) => {
    const rows = await db('nivaro_view_subscriptions as s')
      .join('nivaro_saved_views as v', 'v.id', 's.view_id')
      .where('s.user', req.user?.id ?? '')
      .select(
        's.id',
        's.view_id',
        's.digest',
        's.is_active',
        's.last_run_at',
        'v.name as view_name',
        'v.collection'
      )
    return reply.send({ data: rows })
  })

  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as { view_id?: number; digest?: string }
    const viewId = Number(body.view_id)
    if (!viewId) return reply.code(400).send({ error: 'view_id is required' })
    const digest = body.digest === 'weekly' ? 'weekly' : 'daily'

    const view = (await db('nivaro_saved_views').where({ id: viewId }).first()) as
      | { id: number; user: string; is_shared: boolean | number; role: string | null }
      | undefined
    if (!view) return reply.code(404).send({ error: 'View not found' })

    // Same visibility rule the saved-views list applies: yours, shared to
    // everyone, or shared to your role.
    const mine = String(view.user).toUpperCase() === String(req.user?.id ?? '').toUpperCase()
    const shared = view.is_shared === true || view.is_shared === 1
    const roleOk = !view.role || String(view.role).toUpperCase() === String(req.userRole?.id ?? '').toUpperCase()
    if (!mine && !(shared && roleOk)) return reply.code(403).send({ error: 'Forbidden' })

    const existing = await db('nivaro_view_subscriptions')
      .where({ view_id: viewId, user: req.user?.id })
      .first()
    if (existing) {
      await db('nivaro_view_subscriptions')
        .where({ id: existing.id })
        .update({ digest, is_active: true })
      return reply.send({ data: { id: existing.id, view_id: viewId, digest } })
    }

    const rows = (await db('nivaro_view_subscriptions')
      .insert({
        view_id: viewId,
        user: req.user?.id,
        digest,
        is_active: true,
        created_at: new Date()
      })
      .returning('id')) as unknown[]
    const idRow = rows[0] as { id: number } | number
    const id = typeof idRow === 'object' && idRow !== null ? (idRow as { id: number }).id : idRow
    return reply.code(201).send({ data: { id, view_id: viewId, digest } })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const deleted = await db('nivaro_view_subscriptions')
      .where({ id: Number(id), user: req.user?.id })
      .delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    return reply.code(204).send()
  })
}
