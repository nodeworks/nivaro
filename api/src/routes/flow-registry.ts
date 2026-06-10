import type { FastifyInstance } from 'fastify'
import { listOps, listTriggers } from '../flows/registry.js'
import { authenticate } from '../middleware/authenticate.js'

export async function flowRegistryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/flows/registered-operations', async (_req, reply) => {
    return reply.send({ data: listOps() })
  })

  app.get('/flows/registered-triggers', async (_req, reply) => {
    return reply.send({ data: listTriggers() })
  })
}
