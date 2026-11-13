import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import {
  describePinChange,
  loadPins,
  normalizePinList,
  PIN_EXT,
  pinsKey,
  registeredCollections,
  savePins
} from '../services/collection-pins.js'
import { can } from '../services/permissions.js'
import type { User } from '../types.js'

/**
 * /api/collection-pins — the collections an administrator pins to the top of the
 * Collections page for everyone (services/collection-pins.ts has the storage).
 *
 *   GET  (signed in)  { data: { collections: string[] } } — stored order, only collections
 *                     still registered in this workspace AND readable by the caller.
 *   PUT  (admin)      { collections: string[] } — the whole new list, in order. Names that are
 *                     not registered collections of this workspace are dropped; the answer is
 *                     what was stored. The change is written to the activity log in words.
 *
 * Not under /api/collections on purpose: pins change no form configuration, so the
 * config-write hook (flush + config:update to every open form) has nothing to do here.
 */
export async function collectionPinRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireAuth, resolveWorkspace] }, async (req, reply) => {
    const stored = await loadPins(req.workspaceId)
    const registered = await registeredCollections(req.workspaceId, stored)
    const user = req.user as User | undefined
    const collections: string[] = []
    for (const name of stored) {
      if (!registered.has(name)) continue
      if (!user || !(await can(user, 'read', name))) continue
      collections.push(name)
    }
    return reply.send({ data: { collections } })
  })

  app.put<{ Body: { collections?: unknown } }>(
    '/',
    { preHandler: [requireAdmin, resolveWorkspace] },
    async (req, reply) => {
      const parsed = normalizePinList(req.body?.collections)
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
      const registered = await registeredCollections(req.workspaceId, parsed.list)
      const next = parsed.list.filter((n) => registered.has(n))
      const before = await loadPins(req.workspaceId)
      const change = describePinChange(before, next)
      if (change) {
        await savePins(req.workspaceId, next)
        await logActivity({
          action: 'update',
          user: req.user?.id,
          collection: 'nivaro_extension_settings',
          item: `${PIN_EXT}:${pinsKey(req.workspaceId)}`,
          comment: change,
          req
        })
      }
      return reply.send({ data: { collections: next } })
    }
  )
}
