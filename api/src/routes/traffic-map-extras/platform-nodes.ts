import type { FastifyInstance } from 'fastify'
import { dbServerNow } from '../../services/traffic-taps/db-server.js'
import { platformNodes } from '../../services/traffic-taps/platform-nodes.js'
import '../../services/traffic-taps/storage.js'

/**
 * Traffic Map platform nodes (back-office nodes and badges):
 *   GET /platform-nodes      work queues (#2157), running bulk actions (#2271), pending tuning
 *                            proposals (#2199) and missed cron runs (#2267) in one read — every
 *                            part cached 10–30 s, so a few open maps cost one read per window
 *   GET /db-lens/server      the database server's CPU, IO waits, memory grants and tempdb
 *                            (#2265), from its own dynamic views, cached 15 s, SQL Server only
 * The storage node (#2164) and the heap trend (#2158) ride the existing snapshot / GET /health.
 * Admin only and 404 in cloud mode, like everything under /api/traffic-map.
 */
export async function platformNodesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platform-nodes', async () => ({ data: await platformNodes() }))
  app.get('/db-lens/server', async () => ({ data: await dbServerNow() }))
}
