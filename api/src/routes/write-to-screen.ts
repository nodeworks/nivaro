import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { tenantState } from '../services/ai-tenant-state.js'
import { registerOpsSection } from '../services/ops-report/sections.js'
import { can } from '../services/permissions.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import {
  cleanBeacon,
  loadW2SReport,
  recordW2SSamples,
  takeSampleSlots,
  w2sSectionRows
} from '../services/write-to-screen.js'
import type { User } from '../types.js'

/**
 * Write-to-screen time (realtime round 5, item 25; services/write-to-screen.ts).
 *
 * - POST /api/rum/screen-timing (signed in): a tab's batched samples — sequence, stamp, arrival,
 *   on-screen time (server clock), screen pattern, collection. Never values or record ids. Each
 *   person may send W2S_SAMPLES_PER_MINUTE samples a minute; a sample counts only on a
 *   collection the sender may read and only when its stamp is one the server made. Under /rum so
 *   it rides the RUM telemetry rules (open during maintenance, not a "change" for stuck).
 * - GET /api/realtime/write-to-screen?hours= (admin): p50/p95 overall, delivery vs render, per
 *   hour and per screen + collection.
 *
 * The daily operations report gets "Changes reaching other screens".
 */
const slots = tenantState(() => new Map<string, number[]>())

export async function writeToScreenBeaconRoutes(app: FastifyInstance): Promise<void> {
  app.post('/screen-timing', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user as User | undefined
    const samples = cleanBeacon(req.body)
    if (!user?.id || samples.length === 0) return reply.code(202).send({ data: { accepted: 0 } })
    const allowed = takeSampleSlots(slots(), String(user.id), samples.length, Date.now())
    const readable = new Map<string, boolean>()
    const kept = []
    for (const s of samples.slice(0, allowed)) {
      let ok = readable.get(s.collection)
      if (ok === undefined) {
        ok = await can(user, 'read', s.collection).catch(() => false)
        readable.set(s.collection, ok)
      }
      if (ok) kept.push(s)
    }
    const accepted = await recordW2SSamples(kept, { tenant: currentTenantKey() })
    return reply
      .code(202)
      .send({ data: { accepted, ...(allowed < samples.length ? { limited: true } : {}) } })
  })
}

export async function writeToScreenAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/write-to-screen', { preHandler: requireAdmin }, async (req) => {
    const hours = Math.min(
      14 * 24,
      Math.max(1, Math.floor(Number((req.query as { hours?: string }).hours) || 24))
    )
    const end = new Date()
    const start = new Date(end.getTime() - hours * 3_600_000)
    return { data: await loadW2SReport(start, end, { tenant: currentTenantKey() }) }
  })

  registerOpsSection('write_to_screen', 'Changes reaching other screens', async (win) =>
    w2sSectionRows(await loadW2SReport(win.start, win.end, { tenant: currentTenantKey() }))
  )
}
