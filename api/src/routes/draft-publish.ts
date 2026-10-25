import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  CollectionNotFoundError,
  ForbiddenError,
  ItemNotFoundError,
  readOne,
  updateOne
} from '../services/items.js'
import { isSystemCollection } from '../services/system-collections.js'

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

  // Publish / unpublish / submit for review change the record, so they are
  // the caller's own update through the items service: visibility (User
  // Scopes, row filter), update permission, edit lock, hooks and history
  // apply exactly as for a PATCH of `_status`.
  async function setStatus(
    req: FastifyRequest,
    reply: FastifyReply,
    status: 'published' | 'draft' | 'review',
    action: string
  ) {
    const { collection, id } = req.params as { collection: string; id: string }
    if (isSystemCollection(collection)) return reply.code(403).send({ error: 'Forbidden' })
    try {
      const item = await readOne(req.user!, collection, id, req.workspaceId ?? undefined, ['id'])
      if (!item) return reply.code(404).send({ error: 'Item not found' })
      await updateOne(
        req.user!,
        collection,
        id,
        { _status: status },
        req,
        req.workspaceId ?? undefined
      )
    } catch (err) {
      if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
      if (err instanceof CollectionNotFoundError || err instanceof ItemNotFoundError)
        return reply.code(404).send({ error: 'Item not found' })
      throw err
    }

    await logActivity({ action, user: req.user?.id, collection, item: id, req })

    return reply.send({ data: { id, _status: status } })
  }

  // POST /draft-publish/:collection/:id/publish
  app.post('/:collection/:id/publish', { preHandler: authenticate }, (req, reply) =>
    setStatus(req, reply, 'published', 'publish')
  )

  // POST /draft-publish/:collection/:id/unpublish
  app.post('/:collection/:id/unpublish', { preHandler: authenticate }, (req, reply) =>
    setStatus(req, reply, 'draft', 'unpublish')
  )

  // POST /draft-publish/:collection/:id/submit-review
  app.post('/:collection/:id/submit-review', { preHandler: authenticate }, (req, reply) =>
    setStatus(req, reply, 'review', 'submit_review')
  )
}
