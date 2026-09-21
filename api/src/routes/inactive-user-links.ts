import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  actOnPlatformEntries,
  listInactiveUserRecords,
  listPlatformEntries,
  reassignInactiveUserRecords,
  scanInactiveUserLinks
} from '../services/inactive-user-links.js'
import { deleteOne, updateOne } from '../services/items.js'

// Data Integrity → People: accounts that can no longer act (suspended,
// redacted, anonymised, placeholders) and the live work that still names them.
export async function inactiveUserLinkRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (req) => {
    const q = req.query as { fresh?: string }
    return { data: await scanInactiveUserLinks({ fresh: q.fresh === '1' }) }
  })

  app.get('/:userId/records', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const q = req.query as { source?: string; limit?: string }
    if (!q.source) return reply.code(400).send({ error: 'source is required' })
    const data = await listInactiveUserRecords(userId, q.source, Number(q.limit) || 100)
    if (!data) return reply.code(404).send({ error: 'Unknown source' })
    // Seats, team places, manual owners and tasks are described row by row.
    const entries = q.source.startsWith('builtin:')
      ? await listPlatformEntries(userId, q.source)
      : null
    return { data: { ...data, entries } }
  })

  app.post('/:userId/reassign', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const body = (req.body ?? {}) as { source?: string; to?: string; ids?: string[] }
    if (!body.source || !body.to)
      return reply.code(400).send({ error: 'source and to are required' })
    if (String(body.to).toLowerCase() === userId.toLowerCase())
      return reply.code(400).send({ error: 'Pick someone else' })
    const [from, to] = await Promise.all([
      db('nivaro_users').where('id', userId).first('first_name', 'last_name', 'email'),
      db('nivaro_users')
        .where('id', body.to)
        .first('id', 'status', 'is_redacted', 'first_name', 'last_name')
    ])
    if (!to || to.status !== 'active' || to.is_redacted)
      return reply.code(422).send({ error: 'The successor must be an active account' })
    const fromName =
      [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.email || userId
    const user = req.user!
    if (body.source.startsWith('builtin:')) {
      const acted = await actOnPlatformEntries({
        userId,
        sourceKey: body.source,
        action: 'replace',
        to: body.to,
        ids: body.ids
      })
      if (!acted)
        return reply.code(422).send({ error: 'This assignment cannot be handed on from here' })
      await logActivity({
        action: 'inactive-user-reassign',
        user: user.id,
        collection: acted.table,
        item: userId,
        comment: `${body.source} from ${fromName}: ${acted.moved} moved, ${acted.removed} already held, ${acted.failed.length} failed → ${[to.first_name, to.last_name].filter(Boolean).join(' ')}`
      })
      return { data: acted }
    }
    const result = await reassignInactiveUserRecords(
      {
        userId,
        sourceKey: body.source,
        to: body.to,
        ids: body.ids,
        reason: `Reassigned from ${fromName} (account no longer active)`
      },
      {
        update: (collection, id, data) => updateOne(user, collection, id, data, req),
        remove: (collection, id) => deleteOne(user, collection, id, req)
      }
    )
    if (!result) return reply.code(422).send({ error: 'This link cannot be reassigned from here' })
    await logActivity({
      action: 'inactive-user-reassign',
      user: user.id,
      collection: result.source.collection,
      item: userId,
      comment: `${result.source.label}: ${result.moved} moved, ${result.removed} duplicate links removed, ${result.failed.length} failed → ${[to.first_name, to.last_name].filter(Boolean).join(' ')}`
    })
    return { data: result }
  })

  // Take the account OFF a seat, team, or manual owner row without a successor.
  app.post('/:userId/remove', async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const body = (req.body ?? {}) as { source?: string; ids?: string[] }
    if (!body.source?.startsWith('builtin:'))
      return reply
        .code(400)
        .send({ error: 'Only seats, team places and manual owner rows can be removed here' })
    if (!body.ids?.length) return reply.code(400).send({ error: 'ids are required' })
    const acted = await actOnPlatformEntries({
      userId,
      sourceKey: body.source,
      action: 'remove',
      ids: body.ids
    })
    if (!acted)
      return reply.code(422).send({ error: 'This assignment cannot be removed from here' })
    await logActivity({
      action: 'inactive-user-remove',
      user: req.user!.id,
      collection: acted.table,
      item: userId,
      comment: `${body.source}: ${acted.removed} removed, ${acted.failed.length} failed`
    })
    return { data: acted }
  })
}
