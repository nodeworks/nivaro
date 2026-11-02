import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { endDeviceGrant, listDeviceGrants } from '../services/device-grants.js'
import type { OAuthGrant } from '../services/oauth-store.js'

/**
 * Signed-in phones (under /api): every phone sign-in to a first-party app is a device grant
 * (services/oauth-store.ts, kind 'device'). Never MCP connections — those are /oauth/connections.
 *
 *   GET    /auth/devices                 the caller's phones (`current` = the calling phone)
 *   DELETE /auth/devices/:id             sign one of them out (another person's id: 404)
 *   GET    /users/:userId/devices        a person's phones (admin)
 *   DELETE /users/:userId/devices/:id    sign one of them out (admin; logged with admin_id)
 *
 * Signing a phone out ends its grant, every token and its push rows (endDeviceGrant).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NOT_FOUND = { error: 'That phone is not signed in', code: 'DEVICE_NOT_FOUND' }

const deviceRow = (g: OAuthGrant, currentGrantId?: string) => ({
  id: g.id,
  client_name: g.client_name,
  device_name: g.device_name ?? null,
  platform: g.platform === 'ios' || g.platform === 'android' ? g.platform : null,
  created_at: g.created_at,
  last_used_at: g.last_used_at ?? null,
  current: !!currentGrantId && g.id === currentGrantId
})

async function signOut(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  grantId: string,
  adminId?: string
) {
  if (!UUID.test(grantId)) return reply.code(404).send(NOT_FOUND)
  try {
    const ended = await endDeviceGrant(
      app.redis,
      grantId,
      adminId ? 'removed-by-admin' : 'removed',
      { userId, adminId, req }
    )
    if (!ended) return reply.code(404).send(NOT_FOUND)
  } catch (err) {
    req.log.warn({ err, grant_id: grantId }, 'devices: phone sign-out not finished')
    return reply.code(503).send({
      error: 'Could not sign that phone out. Try again.',
      code: 'DEVICE_SIGN_OUT_FAILED'
    })
  }
  return { ok: true }
}

export async function deviceRoutes(app: FastifyInstance) {
  app.get('/auth/devices', { preHandler: requireAuth }, async (req) => {
    const grants = await listDeviceGrants(app.redis, String(req.user!.id))
    return { data: grants.map((g) => deviceRow(g, req.deviceGrantId)) }
  })

  app.delete<{ Params: { id: string } }>(
    '/auth/devices/:id',
    { preHandler: requireAuth },
    async (req, reply) => signOut(app, req, reply, String(req.user!.id), req.params.id)
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/devices',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!UUID.test(req.params.userId))
        return reply.code(400).send({ error: 'Not a user id', code: 'USER_ID_INVALID' })
      const grants = await listDeviceGrants(app.redis, req.params.userId)
      return { data: grants.map((g) => deviceRow(g, req.deviceGrantId)) }
    }
  )

  app.delete<{ Params: { userId: string; id: string } }>(
    '/users/:userId/devices/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!UUID.test(req.params.userId))
        return reply.code(400).send({ error: 'Not a user id', code: 'USER_ID_INVALID' })
      return signOut(app, req, reply, req.params.userId, req.params.id, String(req.user!.id))
    }
  )
}
