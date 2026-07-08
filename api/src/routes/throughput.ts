import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { aggregateThroughput, parseThroughputParams } from '../services/throughput.js'

export async function throughputRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // GET /reports/throughput?collection=&from=&to=&bucket=&user=
  app.get('/throughput', async (req, reply) => {
    const parsed = parseThroughputParams(req.query as Record<string, unknown>)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    const { rows, unattributed_transitions } = await aggregateThroughput(parsed.params)
    return reply.send({
      data: rows,
      meta: {
        from: parsed.params.from.toISOString(),
        to: parsed.params.to.toISOString(),
        bucket: parsed.params.bucket,
        unattributed_transitions
      }
    })
  })

  // GET /reports/throughput/collections — collections with a workflow binding
  app.get('/throughput/collections', async (_req, reply) => {
    const rows = (await db('nivaro_workflow_bindings as b')
      .leftJoin('nivaro_collections as c', 'c.collection', 'b.collection')
      .distinct('b.collection as collection', 'c.display_name as display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    return reply.send({ data: rows.sort((a, b2) => a.collection.localeCompare(b2.collection)) })
  })
}
