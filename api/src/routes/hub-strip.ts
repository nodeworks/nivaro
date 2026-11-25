import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { readFleetStrip } from '../services/hub/fleet-strip.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import type { StatusCache } from '../services/hub/status.js'

/**
 * GET /api/hub/strip (signed in; HUB=on only) — the standalone Hub's fleet strip: every
 * environment the caller may see with its cached health, in one answer
 * (services/hub/fleet-strip.ts). Admins see every app, owners their own.
 */
export async function hubStripRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return
  app.get('/strip', { preHandler: requireAuth }, async (req) => {
    const redis = (app as unknown as { redis?: StatusCache }).redis ?? null
    return {
      data: await readFleetStrip(String(req.user?.id ?? ''), req.isAdmin === true, { redis })
    }
  })
}
