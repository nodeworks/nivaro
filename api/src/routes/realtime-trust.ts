import type { FastifyInstance } from 'fastify'
import { checkApiKeyScope, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { tenantState } from '../services/ai-tenant-state.js'
import {
  missedSectionRows,
  missedUpdateReport,
  recordMissedBeacon,
  sanitizeBeacon,
  takeBeaconSlot
} from '../services/missed-updates.js'
import { registerOpsSection } from '../services/ops-report/sections.js'
import { can } from '../services/permissions.js'
import { reloadSectionRows, reloadStats } from '../services/reload-stats.js'
import type { User } from '../types.js'

/**
 * Reload trust (realtime ideas 14 + 15), under /api/realtime.
 *
 * - POST /missed-updates (signed in): the missed-update detector's beacon after a reload —
 *   collection, record id, field NAMES, route, seconds (never values or hashes). Each person may
 *   send BEACONS_PER_USER_HOUR an hour; misses are counted only on collections the sender may
 *   read. Answers 202 at once with what was kept.
 * - GET /missed-updates?days= (admin): daily aggregates — misses per collection.field, by source
 *   (delivery / procedure / raw), the procedure when one could be named, and the "trust reloads"
 *   (reloads that compared and found nothing different).
 *
 * The daily operations report gets "Missed live updates" and "Most reloaded screens".
 */
const beaconSlots = tenantState(() => new Map<string, number[]>())

export async function realtimeTrustRoutes(app: FastifyInstance): Promise<void> {
  app.post('/missed-updates', { preHandler: requireAuth }, async (req, reply) => {
    const beacon = sanitizeBeacon(req.body)
    const user = req.user as User | undefined
    if (!beacon || !user?.id) return reply.code(202).send({ data: { accepted: 0 } })
    if (!takeBeaconSlot(beaconSlots(), String(user.id), Date.now()))
      return reply.code(202).send({ data: { accepted: 0, limited: true } })
    const result = await recordMissedBeacon(
      beacon,
      async (collection) =>
        checkApiKeyScope(req, 'read', collection) && can(user, 'read', collection)
    )
    return reply.code(202).send({ data: { accepted: 1, ...result } })
  })

  app.get('/missed-updates', { preHandler: requireAdmin }, async (req) => {
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days) || 7))
    return { data: await missedUpdateReport({ days }) }
  })

  registerOpsSection('missed_live_updates', 'Missed live updates', async (win) =>
    missedSectionRows(await missedUpdateReport({ since: win.start, until: win.end, days: 1 }))
  )
  registerOpsSection('reloaded_screens', 'Most reloaded screens', async (win) =>
    reloadSectionRows(await reloadStats({ since: win.start, until: win.end, days: 1 }))
  )
}
