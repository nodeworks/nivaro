import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { endpointHash, getVapidKeys, sendWebPush } from '../services/web-push.js'

/**
 * Web push subscription management.
 *  GET  /push/vapid-public-key — public key for PushManager.subscribe (auto-generates on first call)
 *  POST /push/subscribe        — upsert this browser's subscription for the current user
 *  POST /push/unsubscribe      — remove by endpoint
 *  GET  /push/status           — does the current user have any subscriptions
 *  POST /push/test             — send a test push to the current user's browsers
 */

interface SubscriptionBody {
  endpoint?: string
  keys?: { p256dh?: string; auth?: string }
}

export async function pushRoutes(app: FastifyInstance) {
  app.get('/vapid-public-key', { preHandler: requireAuth }, async (_req, reply) => {
    const keys = await getVapidKeys()
    return reply.send({ data: { public_key: keys.publicKey } })
  })

  app.post<{ Body: SubscriptionBody }>(
    '/subscribe',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { endpoint, keys } = req.body ?? {}
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return reply.code(400).send({ error: 'endpoint, keys.p256dh and keys.auth are required' })
      }
      if (endpoint.length > 1000 || !/^https:\/\//.test(endpoint)) {
        return reply.code(400).send({ error: 'Invalid endpoint' })
      }
      const hash = endpointHash(endpoint)
      const existing = await db('nivaro_push_subscriptions').where({ endpoint_hash: hash }).first()
      if (existing) {
        await db('nivaro_push_subscriptions')
          .where({ endpoint_hash: hash })
          .update({
            user: req.user!.id,
            keys_p256dh: keys.p256dh,
            keys_auth: keys.auth,
            user_agent: (req.headers['user-agent'] ?? '').slice(0, 500)
          })
      } else {
        await db('nivaro_push_subscriptions').insert({
          user: req.user!.id,
          endpoint,
          endpoint_hash: hash,
          keys_p256dh: keys.p256dh,
          keys_auth: keys.auth,
          user_agent: (req.headers['user-agent'] ?? '').slice(0, 500),
          created_at: new Date()
        })
      }
      return reply.send({ data: { subscribed: true } })
    }
  )

  app.post<{ Body: { endpoint?: string } }>(
    '/unsubscribe',
    { preHandler: requireAuth },
    async (req, reply) => {
      const endpoint = req.body?.endpoint
      if (!endpoint) return reply.code(400).send({ error: 'endpoint is required' })
      await db('nivaro_push_subscriptions')
        .where({ endpoint_hash: endpointHash(endpoint), user: req.user!.id })
        .del()
      return reply.send({ data: { subscribed: false } })
    }
  )

  app.get('/status', { preHandler: requireAuth }, async (req, reply) => {
    const rows = (await db('nivaro_push_subscriptions')
      .where({ user: req.user!.id })
      .count<{ c: number }[]>('id as c')) as Array<{ c: number }>
    return reply.send({ data: { subscriptions: Number(rows[0]?.c ?? 0) } })
  })

  app.post('/test', { preHandler: requireAuth }, async (req, reply) => {
    const sent = await sendWebPush(req.user!.id, {
      title: 'Nivaro test notification',
      body: 'Browser push is working.',
      url: '/notifications'
    })
    return reply.send({ data: { sent } })
  })
}
