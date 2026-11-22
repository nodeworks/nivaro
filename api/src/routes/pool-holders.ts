// api/src/routes/pool-holders.ts
/**
 * GET /api/ops-db/pool-holders (admin) — Database → Connections: who holds a database connection
 * right now and who waits for one, on every API process (services/pool-holders.ts). Never SQL
 * text, never bound values.
 */

import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { isMultiTenant } from '../services/deployment-mode.js'
import { clusterPoolHolders, HOG_MS, HOG_SHARE, recentHogs } from '../services/pool-holders.js'
import { registerReadinessCheck } from '../services/readiness.js'

let checkRegistered = false

export async function poolHoldersRoutes(app: FastifyInstance) {
  if (!checkRegistered && !isMultiTenant()) {
    checkRegistered = true
    registerReadinessCheck({
      id: 'pool-hogs',
      label: 'No one person or feature holds most of a connection pool',
      group: 'Operations',
      description: `Each API process watches its own connection pools: when one person or one feature holds more than ${Math.round(HOG_SHARE * 100)}% of a pool for ${HOG_MS / 1000} s, it is recorded. Database → Connections shows who holds connections right now.`,
      ttlMs: 60_000,
      run: async () => {
        const hogs = await recentHogs()
        if (hogs.length === 0)
          return { status: 'pass', detail: 'Nobody held most of a pool in the last 24 hours.' }
        return {
          status: 'warn',
          detail: `${hogs.length} time(s) in the last 24 hours one person or feature held most of a connection pool. Open Database → Connections.`,
          blockers: hogs
            .slice(0, 10)
            .map(
              (h) =>
                `${new Date(h.at).toISOString()} · ${h.dimension} ${h.label} held ${h.held} of ${h.max} ${h.pool} connections on process ${h.node}`
            )
        }
      }
    })
  }

  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    return reply.send({ data: await clusterPoolHolders() })
  })
}
