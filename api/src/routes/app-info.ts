import type { FastifyInstance } from 'fastify'
import type { TenantBlockMark } from '../lib/app-info-path.js'
import { buildAppInfo } from '../services/app-info.js'

/** GET /api/app-info — what this instance is, for the phone app before anyone signs in. */
export async function appInfoRoutes(app: FastifyInstance) {
  app.get('/app-info', async (req, reply) => {
    const block = (req as unknown as TenantBlockMark).nvrTenantBlock ?? null
    const info = await buildAppInfo({ block })
    return reply.header('cache-control', 'public, max-age=60').send(info)
  })
}
