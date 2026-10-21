import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { canSeeRoom } from '../services/chat.js'
import { type HuddleRedis, huddlePeers, huddleRoomKind } from '../services/huddle.js'
import { destinationPatchError, iceProbeAllowed } from '../services/huddle-destinations.js'
import { defaultSessionStore, type SessionRedis } from '../services/huddle-sessions.js'
import {
  getHuddleSettings,
  iceServersFor,
  iceServersFrom,
  maskHuddleSettings,
  saveHuddleSettings
} from '../services/huddle-settings.js'
import {
  huddleProbeStatus,
  type ProbeRedis,
  runHuddleProbe
} from '../services/huddle-turn-monitor.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Huddles (#2457) over REST — registered under /chat/huddle:
 *   GET  /ice?room=      the signed-in person's ICE servers; a TURN credential is minted only
 *                        for a huddle-capable room the person can see, and nothing while off
 *   GET  /presence?room= who is in the room's huddle (canSeeRoom-gated, like every room read)
 *   GET  /settings       admin: this instance's STUN/TURN settings, secrets masked
 *   GET  /settings/turn-health, POST /settings/turn-health/run  admin: the TURN probe (#2850)
 *   PATCH /settings      admin: save; a masked secret re-submitted keeps the stored value
 *   GET  /settings/test-ice  admin: the SAVED servers with a two-minute TURN credential, for
 *                        the Settings → Huddles connection test (works while huddles are off)
 */
export async function chatHuddleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/ice', async (req, reply) => {
    const raw = String((req.query as { room?: string }).room ?? '')
    const room = huddleRoomKind(raw) === 'ok' ? raw : null
    const data = await iceServersFor(String(req.user!.id), room, (r) => canSeeRoom(req.user!, r))
    return reply.send({ data })
  })

  app.get('/presence', async (req, reply) => {
    const room = String((req.query as { room?: string }).room ?? '')
    if (huddleRoomKind(room) !== 'ok') return reply.send({ data: { room, peers: [] } })
    if (!(await canSeeRoom(req.user!, room))) return reply.code(404).send({ error: 'Not found' })
    const tenant = currentTenantKey()
    const peers = await huddlePeers(app.redis as unknown as HuddleRedis, tenant || null, room)
    return reply.send({ data: { room, peers } })
  })

  app.get('/settings', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: maskHuddleSettings(await getHuddleSettings()) })
  })

  app.get('/settings/test-ice', { preHandler: requireAdmin }, async (req, reply) => {
    const saved = await getHuddleSettings()
    const iceServers = iceServersFrom({ ...saved, turn_ttl_s: 120 }, String(req.user!.id))
    return reply.send({ data: { iceServers } })
  })

  // #2850 — the TURN probe's health strip: last result, a day of history, credential facts.
  app.get('/settings/turn-health', { preHandler: requireAdmin }, async (_req, reply) => {
    const status = await huddleProbeStatus(app.redis as unknown as ProbeRedis)
    let longest = 0
    try {
      const redis = app.redis as unknown as HuddleRedis & SessionRedis
      const rows = await defaultSessionStore(redis).read(
        currentTenantKey() || null,
        new Date(Date.now() - 30 * 24 * 3600_000)
      )
      longest = Math.round(Math.max(0, ...rows.map((r) => r.duration_s)) / 60)
    } catch {
      /* no history yet */
    }
    return reply.send({ data: { ...status, longest_huddle_minutes: longest } })
  })

  app.post('/settings/turn-health/run', { preHandler: requireAdmin }, async (_req, reply) => {
    // Cloud mode: only the platform's servers are ever dialled; none set = nothing to probe.
    if (!iceProbeAllowed()) return reply.code(404).send({ error: 'Not found' })
    const r = await runHuddleProbe({ redis: app.redis as unknown as ProbeRedis })
    return reply.send({
      data: r.skipped ? { skipped: true } : { skipped: false, sample: r.sample }
    })
  })

  app.patch('/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const refused = destinationPatchError(req.body)
    if (refused) return reply.code(400).send({ error: refused, code: 'HUDDLE_DESTINATION' })
    const next = await saveHuddleSettings(req.body)
    await logActivity({
      action: 'update',
      collection: 'nivaro_settings_overrides',
      item: 'huddle',
      user: req.user?.id,
      req,
      comment: `Huddle settings: ${next.enabled ? 'on' : 'off'}, ${next.turn_urls.length} TURN url(s)`
    })
    return reply.send({ data: maskHuddleSettings(next) })
  })
}
