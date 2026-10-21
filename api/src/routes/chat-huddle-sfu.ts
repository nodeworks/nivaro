import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { canSeeRoom } from '../services/chat.js'
import { type HuddleRedis, huddlePeers, huddleRoomKind } from '../services/huddle.js'
import { getHuddleSettings, sfuConfigured } from '../services/huddle-settings.js'
import { mintJoinToken, probeLiveKit } from '../services/huddle-sfu.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Large huddles (#2859) over REST — registered under /chat/huddle next to the
 * mesh routes:
 *   GET /sfu-token?room=&socket=  a LiveKit access token for the room's SFU room. Gated like
 *                                 every huddle read (canSeeRoom) AND by presence: the socket
 *                                 must already be in the room's huddle as this person, so a
 *                                 token only ever goes to someone the server listed there.
 *   GET /settings/test-sfu        admin: is the SAVED media server reachable with the saved
 *                                 key/secret (lists rooms through its API; nothing is created)
 * The API secret is read from the settings row and only ever used to sign; it is never in a
 * response or a log line.
 */
export async function chatHuddleSfuRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/sfu-token', async (req, reply) => {
    const q = req.query as { room?: string; socket?: string }
    const room = String(q.room ?? '')
    const socket = typeof q.socket === 'string' ? q.socket.slice(0, 64) : ''
    if (huddleRoomKind(room) !== 'ok' || !socket) {
      return reply.code(400).send({ error: 'A huddle room and your socket id are required' })
    }
    const user = req.user!
    if (!(await canSeeRoom(user, room))) return reply.code(404).send({ error: 'Not found' })
    const s = await getHuddleSettings()
    if (!s.enabled || !sfuConfigured(s)) {
      return reply.code(404).send({ error: 'Large huddles are not configured on this instance' })
    }
    const tenant = currentTenantKey() || null
    const peers = await huddlePeers(app.redis as unknown as HuddleRedis, tenant, room)
    const me = peers.find((p) => p.socket === socket && p.user === String(user.id))
    if (!me) return reply.code(409).send({ error: 'Join the huddle first' })
    const minted = mintJoinToken({
      apiKey: s.livekit_api_key as string,
      apiSecret: s.livekit_api_secret as string,
      tenant,
      room,
      userId: String(user.id),
      socket,
      name: me.name
    })
    return reply.send({ data: { url: s.livekit_url, ...minted } })
  })

  app.get('/settings/test-sfu', { preHandler: requireAdmin }, async (_req, reply) => {
    const s = await getHuddleSettings()
    if (!sfuConfigured(s)) return reply.send({ data: { ok: false, reason: 'not-configured' } })
    const result = await probeLiveKit({
      livekit_url: s.livekit_url as string,
      livekit_api_key: s.livekit_api_key as string,
      livekit_api_secret: s.livekit_api_secret as string
    })
    return reply.send({ data: result })
  })
}
