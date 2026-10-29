import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  canEditView,
  canSeeView,
  createView,
  deleteView,
  getView,
  listViews,
  sendActivityView,
  updateView,
  validateViewInput
} from '../services/activity-views.js'
import { resyncAfterWrites } from '../services/row-schedules.js'

/**
 * Saved audit views (#11, migration 517) at /api/activity-views — administrators only (the
 * audit log is). Share rules live in services/activity-views.ts:
 *   GET    /             mine + shared + system views
 *   POST   /             {name, filters, shared?, schedule?, recipients?}
 *   PATCH  /:id          owner (or any admin for a system view)
 *   DELETE /:id          same
 *   POST   /:id/run      email it now to its recipients (rendered per recipient)
 */
export async function activityViewRoutes(app: FastifyInstance) {
  // A saved, edited or removed schedule takes effect at once, on every process.
  resyncAfterWrites(app, 'activity-views')
  app.addHook('preHandler', requireAdmin)

  const me = (req: { user?: { id?: string } }) => String(req.user?.id ?? '')

  app.get('/', async (req) => ({ data: await listViews(me(req)) }))

  app.get('/:id', async (req, reply) => {
    const view = await getView(Number((req.params as { id: string }).id))
    if (!view || !canSeeView(view, me(req))) return reply.code(404).send({ error: 'Not found' })
    return { data: { ...view, editable: canEditView(view, me(req)) } }
  })

  app.post('/', async (req, reply) => {
    const v = validateViewInput(req.body, { partial: false })
    if ('error' in v) return reply.code(400).send({ error: v.error })
    const view = await createView(me(req), v.value)
    await logActivity({
      action: 'create',
      user: me(req),
      collection: 'nivaro_activity_views',
      item: String(view.id),
      comment: `Saved audit view "${view.name}"`,
      req
    })
    return reply.code(201).send({ data: view })
  })

  app.patch('/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const view = await getView(id)
    if (!view || !canSeeView(view, me(req))) return reply.code(404).send({ error: 'Not found' })
    if (!canEditView(view, me(req)))
      return reply.code(403).send({
        error: 'Only the owner can change this view — save a copy instead',
        code: 'NOT_OWNER'
      })
    const v = validateViewInput(req.body, { partial: true })
    if ('error' in v) return reply.code(400).send({ error: v.error })
    await updateView(id, v.value)
    await logActivity({
      action: 'update',
      user: me(req),
      collection: 'nivaro_activity_views',
      item: String(id),
      comment: `Changed ${Object.keys(v.value).join(', ') || 'nothing'}`,
      req
    })
    const fresh = await getView(id)
    return { data: fresh ? { ...fresh, editable: true } : null }
  })

  app.delete('/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const view = await getView(id)
    if (!view || !canSeeView(view, me(req))) return reply.code(404).send({ error: 'Not found' })
    if (!canEditView(view, me(req)))
      return reply
        .code(403)
        .send({ error: 'Only the owner can remove this view', code: 'NOT_OWNER' })
    await deleteView(id)
    await logActivity({
      action: 'delete',
      user: me(req),
      collection: 'nivaro_activity_views',
      item: String(id),
      comment: `Removed audit view "${view.name}"`,
      req
    })
    return reply.code(204).send()
  })

  app.post('/:id/run', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const view = await getView(id)
    if (!view || !canSeeView(view, me(req))) return reply.code(404).send({ error: 'Not found' })
    if (!canEditView(view, me(req)))
      return reply.code(403).send({ error: 'Only the owner can send this view', code: 'NOT_OWNER' })
    if (view.recipients.length === 0)
      return reply.code(400).send({ error: 'Add at least one recipient first' })
    const result = await sendActivityView(view)
    return { data: result }
  })
}
