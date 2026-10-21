import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { canSeeRoom } from '../services/chat.js'
import {
  defaultHuddleDeps,
  type HuddleRedis,
  huddleMode,
  huddlePeers,
  huddleRoomKind,
  huddleSession,
  setHuddleStaleEvictor,
  staleEvictorFor
} from '../services/huddle.js'
import { getHuddleSettings, sfuConfigured } from '../services/huddle-settings.js'
import { mintJoinToken, probeLiveKit, sfuTokenDecision } from '../services/huddle-sfu.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Large huddles (#2859) over REST — registered under /chat/huddle next to the
 * mesh routes:
 *   GET /sfu-token?room=&socket=  a LiveKit access token for the huddle's SFU room. Gated like
 *                                 every huddle read (canSeeRoom), then by the huddle being ON
 *                                 the SFU right now, and by presence: the socket must already
 *                                 be in the room's huddle as this person (sfuTokenDecision).
 *                                 The room name is bound to the huddle session, so a token from
 *                                 an earlier huddle in the same room opens nothing.
 *   GET /settings/test-sfu        admin: is the SAVED media server reachable with the saved
 *                                 key/secret (lists rooms through its API; nothing is created)
 * The API secret is read from the settings row and only ever used to sign; it is never in a
 * response or a log line. Leaving, going stale or losing room access also removes the person
 * from the LiveKit room server-side (services/huddle.ts), since a connection outlives its token.
 */
export async function chatHuddleSfuRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  // A REST roster read (presence, this token route) prunes stale browsers too: install the
  // evictor here so a process that has served no socket yet still tells the SFU.
  setHuddleStaleEvictor(staleEvictorFor(defaultHuddleDeps(app)))

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
    const tenant = currentTenantKey() || null
    const redis = app.redis as unknown as HuddleRedis
    const [mode, session, peers] = await Promise.all([
      huddleMode(redis, tenant, room),
      huddleSession(redis, tenant, room),
      huddlePeers(redis, tenant, room)
    ])
    const d = sfuTokenDecision({
      enabled: s.enabled,
      sfu: sfuConfigured(s),
      mode,
      session,
      peers,
      userId: String(user.id),
      socket
    })
    if (!d.ok) return reply.code(d.status).send({ error: d.error })
    const minted = mintJoinToken({
      apiKey: s.livekit_api_key as string,
      apiSecret: s.livekit_api_secret as string,
      tenant,
      room,
      session: d.session,
      userId: String(user.id),
      socket,
      name: d.me.name
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
