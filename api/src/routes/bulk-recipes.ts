import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

/**
 * Bulk-action recipes (#26): a configured bulk update or transition saved as a
 * named preset on the bulk bar ("Close out + reason: duplicate"). The recipe
 * only stores WHAT to do — execution still goes through the existing
 * bulk-update / bulk-transition endpoints, so RBAC, validation and hooks
 * apply per record exactly as a hand-configured action would.
 *
 * Transitions are stored by LABEL, not id: transition ids are template-row
 * ids that change across template redesigns, while the label is what the
 * person saved. The client matches label → currently-available transition at
 * click time and disables the recipe when no transition carries that label.
 */
export async function bulkRecipeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth)

  app.get<{ Querystring: { collection?: string } }>('/', async (req, reply) => {
    const collection = String(req.query.collection ?? '')
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    const rows = await db('nivaro_bulk_recipes')
      .where({ collection })
      .where((qb) => qb.where('is_shared', true).orWhere('created_by', req.user!.id))
      .orderBy('name', 'asc')
      .select('*')
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        config: (() => {
          try {
            return JSON.parse(String(r.config))
          } catch {
            return null
          }
        })(),
        mine: String(r.created_by ?? '').toUpperCase() === String(req.user!.id).toUpperCase()
      }))
    }
  })

  app.post('/', async (req, reply) => {
    const b = req.body as {
      collection?: string
      name?: string
      action_type?: string
      config?: unknown
      is_shared?: boolean
    }
    const collection = String(b.collection ?? '')
    const name = String(b.name ?? '').trim()
    if (!collection || !name || !b.config) {
      return reply.code(400).send({ error: 'collection, name and config are required' })
    }
    if (!['update', 'transition'].includes(String(b.action_type))) {
      return reply.code(400).send({ error: 'action_type must be update or transition' })
    }
    if (!req.isAdmin && !(await can(req.user!, 'update', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const [inserted] = await db('nivaro_bulk_recipes')
      .insert({
        collection,
        name: name.slice(0, 200),
        action_type: b.action_type,
        config: JSON.stringify(b.config),
        is_shared: b.is_shared !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'bulk-recipe-create',
      user: req.user?.id,
      collection,
      comment: name,
      req
    })
    return reply.code(201).send({ data: { id } })
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_bulk_recipes').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const mine = String(row.created_by ?? '').toUpperCase() === String(req.user!.id).toUpperCase()
    if (!mine && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    await db('nivaro_bulk_recipes').where('id', row.id).del()
    await logActivity({
      action: 'bulk-recipe-delete',
      user: req.user?.id,
      collection: String(row.collection),
      comment: String(row.name),
      req
    })
    return { data: { deleted: true } }
  })
}
