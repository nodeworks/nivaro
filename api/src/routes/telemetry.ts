import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { telemetryStatus } from '../services/telemetry-status.js'

/**
 * The external telemetry stack, seen from Nivaro (#2544): settings, what this process sends,
 * what arrived, and the stack's own health. Administrators only.
 */
export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/status', { preHandler: requireAdmin }, async () => ({ data: await telemetryStatus() }))
}
