import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { exportBlueprint, installBlueprint, isBlueprint } from '../services/blueprints.js'

/** App blueprints — export/install schema+workflow+layout+queue bundles. */
export async function blueprintsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.post('/export', async (req, reply) => {
    const b = req.body as { name?: string; collections?: string[] }
    if (!b.name?.trim() || !Array.isArray(b.collections) || b.collections.length === 0) {
      return reply.code(400).send({ error: 'name and collections are required' })
    }
    for (const c of b.collections) {
      if (!/^[a-zA-Z0-9_]+$/.test(c) || c.startsWith('nivaro_')) {
        return reply.code(400).send({ error: `Invalid collection: ${c}` })
      }
    }
    const blueprint = await exportBlueprint(b.name.trim(), b.collections)
    await logActivity({
      action: 'blueprint-export',
      user: req.user?.id,
      comment: `${b.name}: ${b.collections.join(', ')}`.slice(0, 400),
      req
    })
    return reply.send({ data: blueprint })
  })

  app.post('/install', async (req, reply) => {
    const { blueprint } = req.body as { blueprint?: unknown }
    if (!isBlueprint(blueprint)) {
      return reply.code(400).send({ error: 'Not a nivaro-blueprint artifact' })
    }
    const report = await installBlueprint(blueprint, req.user?.id ?? null)
    await logActivity({
      action: 'blueprint-install',
      user: req.user?.id,
      comment: `${blueprint.name}: +${report.collections.created} collections, +${report.workflows.created} workflows, +${report.queues.created} queues`.slice(
        0,
        400
      ),
      req
    })
    return reply.send({ data: report })
  })
}
