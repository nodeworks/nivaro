import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { copyRulesFor } from '../services/copy-rules.js'
import { can } from '../services/permissions.js'
import { isSystemCollection } from '../services/system-collections.js'

/**
 * GET /api/copy-rules/:collection → { skip: { <field>: <reason> } }
 *
 * The fields that never follow a record into a copy (services/copy-rules.ts) —
 * what More → Duplicate, Save as template and the Clone dialog leave out, the
 * same rule POST /items/:c/:id/clone applies on the server. Field NAMES and
 * reasons only, never values. Signed in; the caller must be able to read the
 * collection (403 otherwise); system collections are refused.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export async function copyRulesRoutes(app: FastifyInstance) {
  app.get('/:collection', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    if (isSystemCollection(collection)) return reply.code(403).send({ error: 'Forbidden' })
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Sign in first' })
    if (!(await can(user, 'read', collection).catch(() => false)))
      return reply.code(403).send({ error: 'You cannot read this collection' })
    const skip = await copyRulesFor(collection)
    return reply.send({ data: { skip: Object.fromEntries(skip) } })
  })
}
