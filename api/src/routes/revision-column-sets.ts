import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import {
  loadSets,
  normalizeSets,
  roleDefault,
  SETS_EXT,
  saveSets,
  setsKey,
  validCollection
} from '../services/revision-column-sets.js'
import type { User } from '../types.js'

/**
 * /api/revision-column-sets/:collection — shared column sets for the Revision history table.
 * GET (anyone who may read the collection): the sets, which one is the default for the caller's
 * role; role ids only for administrators. PUT (admin): replace the collection's sets.
 */
export async function revisionColumnSetRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string } }>(
    '/:collection',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection } = req.params
      if (!validCollection(collection)) return reply.code(400).send({ error: 'Not a collection' })
      const user = req.user as User
      if (!(await can(user, 'read', collection)))
        return reply.code(404).send({ error: 'Not found' })
      const sets = await loadSets(collection)
      const mine = roleDefault(sets, user.role)
      return reply.send({
        data: {
          sets: sets.map((s) => ({
            id: s.id,
            name: s.name,
            fields: s.fields,
            is_default: s.is_default,
            ...(req.isAdmin ? { default_roles: s.default_roles } : {})
          })),
          role_default: mine ? { id: mine.id, name: mine.name, fields: mine.fields } : null
        }
      })
    }
  )

  app.put<{ Params: { collection: string }; Body: { sets?: unknown } }>(
    '/:collection',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection } = req.params
      if (!validCollection(collection)) return reply.code(400).send({ error: 'Not a collection' })
      const parsed = normalizeSets(req.body?.sets)
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
      await saveSets(collection, parsed.sets)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_extension_settings',
        item: `${SETS_EXT}:${setsKey(collection)}`,
        comment: `Revision history column sets for ${collection}: ${
          parsed.sets.map((s) => s.name).join(', ') || 'none'
        }`,
        req
      })
      return reply.send({ data: { sets: parsed.sets } })
    }
  )
}
