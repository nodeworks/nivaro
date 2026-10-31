import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { isExpoPushToken, PHONE_PREFIX, sendPhonePush } from '../services/phone-push.js'
import { endpointHash, getVapidKeys, sendWebPush } from '../services/web-push.js'

/**
 * Web push subscription management.
 *  GET  /push/vapid-public-key — public key for PushManager.subscribe (auto-generates on first call)
 *  POST /push/subscribe        — upsert this browser's subscription for the current user
 *  POST /push/unsubscribe      — remove by endpoint
 *  GET  /push/status           — does the current user have any subscriptions
 *  POST /push/test             — send a test push to the current user's browsers
 *
 * Phones (Expo apps; stored as `expo:<token>` rows, services/phone-push.ts):
 *  GET    /push/phones        — the current user's phones
 *  POST   /push/phones        — register this phone {token, platform?, app?, device_name?}
 *  DELETE /push/phones        — remove this phone {token} (sign-out)
 *  POST   /push/phones/forget — remove this phone {token} WITHOUT a sign-in: holding the token
 *                               proves it is this phone, so a sign-out that lost its session
 *                               (expired token, offline) can still stop the alerts later
 *  POST   /push/phones/test   — send a test alert to the current user's phones
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
        // The same browser subscription (same keys) moves to whoever signs in
        // on it; anyone else's endpoint is not re-pointed by naming it.
        const sameBrowser = existing.keys_p256dh === keys.p256dh && existing.keys_auth === keys.auth
        if (
          String(existing.user ?? '').toUpperCase() !== String(req.user!.id).toUpperCase() &&
          !sameBrowser
        ) {
          return reply.code(409).send({ error: 'This push endpoint belongs to another account' })
        }
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
      .select(db.raw(`CASE WHEN endpoint LIKE '${PHONE_PREFIX}%' THEN 1 ELSE 0 END as phone`))
      .count({ c: '*' })
      .groupBy(db.raw(`CASE WHEN endpoint LIKE '${PHONE_PREFIX}%' THEN 1 ELSE 0 END`))) as Array<{
      phone: number | string
      c: number | string
    }>
    const of = (phone: number) => Number(rows.find((r) => Number(r.phone) === phone)?.c ?? 0)
    // `subscriptions` stays browsers only: the browser UI reads it.
    return reply.send({ data: { subscriptions: of(0), phones: of(1) } })
  })

  app.post('/test', { preHandler: requireAuth }, async (req, reply) => {
    const sent = await sendWebPush(req.user!.id, {
      title: 'Nivaro test notification',
      body: 'Browser push is working.',
      url: '/notifications'
    })
    return reply.send({ data: { sent } })
  })

  app.get('/phones', { preHandler: requireAuth }, async (req, reply) => {
    const rows = (await db('nivaro_push_subscriptions')
      .where({ user: req.user!.id })
      .where('endpoint', 'like', `${PHONE_PREFIX}%`)
      .orderBy('created_at', 'desc')
      .select('id', 'keys_auth', 'user_agent', 'created_at', 'last_used_at')) as Array<{
      id: number
      keys_auth: string
      user_agent: string | null
      created_at: Date
      last_used_at: Date | null
    }>
    return reply.send({
      data: rows.map((r) => {
        const [platform, ...appParts] = String(r.keys_auth ?? '').split(':')
        return {
          id: r.id,
          platform: platform || null,
          app: appParts.join(':') || null,
          device_name: r.user_agent,
          created_at: r.created_at,
          last_used_at: r.last_used_at
        }
      })
    })
  })

  app.post<{
    Body: { token?: string; platform?: string; app?: string; device_name?: string }
  }>('/phones', { preHandler: requireAuth }, async (req, reply) => {
    const { token, platform, app: appId, device_name } = req.body ?? {}
    if (!isExpoPushToken(token)) {
      return reply.code(400).send({ error: 'token must be an Expo push token' })
    }
    const endpoint = `${PHONE_PREFIX}${token}`
    const hash = endpointHash(endpoint)
    const plat = ['ios', 'android'].includes(String(platform)) ? String(platform) : 'unknown'
    const appKey =
      String(appId ?? '')
        .replace(/[^\w.-]/g, '')
        .slice(0, 100) || 'app'
    const fields = {
      user: req.user!.id,
      keys_p256dh: 'expo',
      keys_auth: `${plat}:${appKey}`.slice(0, 255),
      user_agent: (typeof device_name === 'string' && device_name.trim()
        ? device_name.trim()
        : String(req.headers['user-agent'] ?? '')
      ).slice(0, 500)
    }
    // A phone belongs to whoever signed in on it last: a token is the app install, not the
    // person, so a second person signing in on a shared phone takes its alerts over.
    const existing = await db('nivaro_push_subscriptions')
      .where({ endpoint_hash: hash })
      .first('id')
    if (existing) {
      await db('nivaro_push_subscriptions').where({ endpoint_hash: hash }).update(fields)
    } else {
      await db('nivaro_push_subscriptions').insert({
        ...fields,
        endpoint,
        endpoint_hash: hash,
        created_at: new Date()
      })
    }
    return reply.send({ data: { registered: true } })
  })

  app.delete<{ Body: { token?: string } }>(
    '/phones',
    { preHandler: requireAuth },
    async (req, reply) => {
      const token = req.body?.token
      if (!isExpoPushToken(token)) {
        return reply.code(400).send({ error: 'token must be an Expo push token' })
      }
      const removed = await db('nivaro_push_subscriptions')
        .where({ endpoint_hash: endpointHash(`${PHONE_PREFIX}${token}`), user: req.user!.id })
        .del()
      return reply.send({ data: { removed: Number(removed) > 0 } })
    }
  )

  app.post<{ Body: { token?: string } }>('/phones/forget', async (req, reply) => {
    const token = req.body?.token
    if (!isExpoPushToken(token)) {
      return reply.code(400).send({ error: 'token must be an Expo push token' })
    }
    // Same answer whether or not it was registered: the route says nothing about tokens.
    await db('nivaro_push_subscriptions')
      .where({ endpoint_hash: endpointHash(`${PHONE_PREFIX}${token}`) })
      .del()
    return reply.send({ data: { removed: true } })
  })

  app.post('/phones/test', { preHandler: requireAuth }, async (req, reply) => {
    const sent = await sendPhonePush(req.user!.id, {
      title: 'Test alert',
      body: 'Phone alerts are working.',
      data: { url: '/notifications' }
    })
    return reply.send({ data: { sent } })
  })
}
