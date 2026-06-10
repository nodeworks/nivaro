import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

export async function draftPublishRoutes(app: FastifyInstance) {
  // GET /draft-publish/:collection/config
  app.get('/:collection/config', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const col = await db('nivaro_collections').where({ collection }).first()
    if (!col) return reply.code(404).send({ error: 'Collection not found' })

    return reply.send({
      data: {
        collection,
        draft_publish_enabled: !!col.draft_publish_enabled
      }
    })
  })

  // PATCH /draft-publish/:collection/config
  app.patch('/:collection/config', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const body = req.body as { draft_publish_enabled: boolean }

    const col = await db('nivaro_collections').where({ collection }).first()
    if (!col) return reply.code(404).send({ error: 'Collection not found' })

    await db('nivaro_collections')
      .where({ collection })
      .update({ draft_publish_enabled: body.draft_publish_enabled ? 1 : 0 })

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: String(col.id),
      req
    })

    return reply.send({
      data: {
        collection,
        draft_publish_enabled: body.draft_publish_enabled
      }
    })
  })

  // POST /draft-publish/:collection/:id/publish
  app.post('/:collection/:id/publish', { preHandler: authenticate }, async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }

    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const item = await db(collection).where({ id }).first()
    if (!item) return reply.code(404).send({ error: 'Item not found' })

    await db(collection).where({ id }).update({ _status: 'published' })

    await logActivity({
      action: 'publish',
      user: req.user?.id,
      collection,
      item: id,
      req
    })

    return reply.send({ data: { id, _status: 'published' } })
  })

  // POST /draft-publish/:collection/:id/unpublish
  app.post('/:collection/:id/unpublish', { preHandler: authenticate }, async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }

    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const item = await db(collection).where({ id }).first()
    if (!item) return reply.code(404).send({ error: 'Item not found' })

    await db(collection).where({ id }).update({ _status: 'draft' })

    await logActivity({
      action: 'unpublish',
      user: req.user?.id,
      collection,
      item: id,
      req
    })

    return reply.send({ data: { id, _status: 'draft' } })
  })

  // POST /draft-publish/:collection/:id/submit-review
  app.post('/:collection/:id/submit-review', { preHandler: authenticate }, async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }

    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const item = await db(collection).where({ id }).first()
    if (!item) return reply.code(404).send({ error: 'Item not found' })

    await db(collection).where({ id }).update({ _status: 'review' })

    await logActivity({
      action: 'submit_review',
      user: req.user?.id,
      collection,
      item: id,
      req
    })

    return reply.send({ data: { id, _status: 'review' } })
  })
}
