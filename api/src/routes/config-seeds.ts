/** Config seeds (#828): the catalog with each seed's drift, admin only. */
import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { listConfigSeeds, seedDrift } from '../services/config-seeds.js'

export async function configSeedRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => ({
    data: listConfigSeeds().map((s) => ({
      key: s.key,
      owner: s.owner,
      label: s.label ?? null,
      collection: s.collection,
      match_by: s.match_by,
      mode: s.mode,
      source: s.file ? 'file' : 'inline',
      task: `seed:${s.key}`
    }))
  }))

  app.get('/:key/drift', async (req, reply) => {
    const { key } = req.params as { key: string }
    try {
      return { data: await seedDrift(key, req.user?.id ?? null) }
    } catch (err) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'drift failed' })
    }
  })
}
