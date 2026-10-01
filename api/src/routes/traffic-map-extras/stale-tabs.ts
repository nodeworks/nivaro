// api/src/routes/traffic-map-extras/stale-tabs.ts
import type { FastifyInstance } from 'fastify'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { STALE_TABS_TAP } from '../../services/traffic-taps/stale-tabs.js'
import { trafficTaps } from '../../services/traffic-taps.js'

/**
 * #1180 — GET /traffic-map/stale-tabs?window=60|300|900: open tabs per app and build over the
 * window, and how many run an old frontend build or loaded against an older API. Reads only the
 * caller's store, so it answers in cloud mode too.
 */
const WINDOWS = new Set([60, 300, 900])

export async function staleTabsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { window?: string } }>(
    '/stale-tabs',
    { config: { trafficTenantAware: true } },
    async (req, reply) => {
      const windowS = Number(req.query.window ?? 300)
      if (!WINDOWS.has(windowS))
        return reply
          .code(400)
          .send({ error: 'window must be 60, 300 or 900', code: 'LENS_INVALID' })
      const tap = trafficTaps().find((t) => t.id === STALE_TABS_TAP)
      return { data: tap?.snapshot?.(windowS, currentTrafficSec()) ?? null }
    }
  )
}
