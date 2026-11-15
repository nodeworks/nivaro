import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { approvalChangesFor } from '../services/approval-changes.js'

/**
 * /api/approval-changes — "Changed after approval" (round 7, item 21,
 * services/approval-changes.ts).
 *
 *   GET /record/:collection/:item   the record's changes since it was approved, as the caller
 *
 * The record is read as the caller (readOne: role, row filter, User Scopes — null = 404) and
 * only fields the caller may read are compared, so a hidden field never shows that it moved.
 * Under View-as the answer is exactly the person's.
 */

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const ITEM_RE = /^[A-Za-z0-9_\-:.]{1,100}$/

export async function approvalChangeRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; item: string } }>(
    '/record/:collection/:item',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!COLLECTION_RE.test(collection) || /^(nivaro_|directus_)/i.test(collection))
        return reply.code(400).send({ error: 'Not a valid collection' })
      if (!ITEM_RE.test(item)) return reply.code(400).send({ error: 'Not a valid record id' })
      const user = req.user!
      const { readOne } = await import('../services/items.js')
      const row = (await readOne(user, collection, item, req.workspaceId ?? undefined).catch(
        () => null
      )) as Record<string, unknown> | null
      if (!row) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data: await approvalChangesFor(user, collection, item, row) })
    }
  )
}
