import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { noteConnectionReport, parseConnectionReport } from '../services/traffic-taps/realtime.js'

/**
 * POST /api/connection-reports — a browser says its live-update connection failed or had to
 * fall back to long-polling (#2263). Any signed-in user may send one; the Traffic Map groups
 * them by network, browser and app so a corporate proxy or an extension breaking live updates
 * shows up as one row. Nothing is stored: the figures are in memory (24 h) on this process, and
 * the reporter is only ever counted. At most 6 reports a minute per user.
 */
const MAX_PER_MIN = 6
const seen = new Map<string, { min: number; n: number }>()

/** Allow `who` another report this minute? Bounded; pure over its map. */
export function allowReport(who: string, now = Date.now()): boolean {
  const min = Math.floor(now / 60_000)
  const cur = seen.get(who)
  if (!cur || cur.min !== min) {
    if (seen.size > 5000) seen.clear()
    seen.set(who, { min, n: 1 })
    return true
  }
  if (cur.n >= MAX_PER_MIN) return false
  cur.n++
  return true
}

export async function connectionReportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const report = parseConnectionReport(req.body)
    if (!report) return reply.code(400).send({ error: 'kind must be failed or downgraded' })
    const who = String(req.user?.id ?? '')
    if (who && allowReport(who)) {
      noteConnectionReport(
        report,
        who,
        String(req.headers['user-agent'] ?? ''),
        String(req.headers['x-forwarded-for'] ?? '')
          .split(',')[0]
          ?.trim() || req.ip
      )
    }
    return reply.code(204).send()
  })
}
