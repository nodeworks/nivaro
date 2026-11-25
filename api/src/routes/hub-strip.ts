import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { readFleetStrip, type StripCache } from '../services/hub/fleet-strip.js'
import { hubModeEnabled } from '../services/hub/mode.js'

/**
 * GET /api/hub/strip (HUB=on only; behind the Hub credential gate, which turns this requireAuth
 * into hubRequireAuth: keys need hub:read) — the standalone Hub's fleet strip: every environment
 * the caller may see with its CACHED health, in one answer, never a live probe
 * (services/hub/fleet-strip.ts). Admins see every app, owners their own.
 */
export async function hubStripRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return
  app.get('/strip', { preHandler: requireAuth }, async (req) => {
    const redis = (app as unknown as { redis?: StripCache }).redis ?? null
    return {
      data: await readFleetStrip(String(req.user?.id ?? ''), req.isAdmin === true, { redis })
    }
  })
}
