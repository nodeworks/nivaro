import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { canSeeRoom } from '../services/chat.js'
import { type HuddleRedis, huddlePeers, huddleRoomKind } from '../services/huddle.js'
import {
  getHuddleSettings,
  iceServersFor,
  maskHuddleSettings,
  saveHuddleSettings
} from '../services/huddle-settings.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Huddles (#2457) over REST — registered under /chat/huddle:
 *   GET  /ice            the signed-in person's ICE servers (TURN credential minted per call)
 *   GET  /presence?room= who is in the room's huddle (canSeeRoom-gated, like every room read)
 *   GET  /settings       admin: this instance's STUN/TURN settings, secrets masked
 *   PATCH /settings      admin: save; a masked secret re-submitted keeps the stored value
 */
export async function chatHuddleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/ice', async (req, reply) => {
    const data = await iceServersFor(String(req.user!.id))
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

  app.patch('/settings', { preHandler: requireAdmin }, async (req, reply) => {
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
