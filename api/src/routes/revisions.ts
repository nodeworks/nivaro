import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import { getRevision, listRevisions } from '../services/revisions.js'

export async function revisionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const q = req.query as { collection?: string; item?: string }
    if (!q.collection || !q.item) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }
    const data = await listRevisions(q.collection, q.item)
    return reply.send({ data })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const revision = await getRevision(Number(id))
    if (!revision) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: revision })
  })

  // POST /revisions/:id/rollback — restore item state from a revision snapshot
  app.post('/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string }

    const revision = (await db('nivaro_revisions')
      .where({ id: Number(id) })
      .first()) as
      | { id: number; activity: number; data: string | Record<string, unknown> }
      | undefined
    if (!revision) return reply.code(404).send({ error: 'Not found' })

    // Parse the snapshot data
    let revisionData: Record<string, unknown>
    try {
      revisionData =
        typeof revision.data === 'string'
          ? (JSON.parse(revision.data) as Record<string, unknown>)
          : (revision.data as Record<string, unknown>)
    } catch {
      return reply.code(400).send({ error: 'Could not parse revision data' })
    }

    // Get the activity record to find collection + item
    const activity = (await db('nivaro_activity').where({ id: revision.activity }).first()) as
      | { id: number; collection: string | null; item: string | null }
      | undefined
    if (!activity || !activity.collection || !activity.item) {
      return reply.code(404).send({ error: 'Activity record not found for this revision' })
    }

    if (activity.collection.startsWith('nivaro_') && !(req.isAdmin ?? false)) {
      return reply.code(403).send({ error: 'Cannot rollback system table records' })
    }
    if (!(await can(req.user!, 'update', activity.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Remove the id from the update payload
    const updatePayload = { ...revisionData }
    delete updatePayload.id

    // Restore the item
    await db(activity.collection).where({ id: activity.item }).update(updatePayload)

    // Log the rollback action
    await logActivity({
      action: 'rollback',
      user: req.user?.id,
      collection: activity.collection,
      item: activity.item,
      comment: JSON.stringify({ revision_id: id }),
      req
    })

    return reply.send({
      data: {
        success: true,
        collection: activity.collection,
        item: activity.item
      }
    })
  })
}
