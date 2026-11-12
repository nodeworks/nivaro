import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  credentialLive,
  deletePushRowsOrKeep,
  notePhoneRegistered,
  type PushCredential,
  staticTokenStamp
} from '../services/device-grants.js'
import { addGrantPushId } from '../services/oauth-store.js'
import {
  instanceName,
  instanceOrigin,
  isExpoPushToken,
  PHONE_PREFIX,
  phonePushMode,
  sendPhonePush
} from '../services/phone-push.js'
import {
  clearRelayKey,
  connectPushRelay,
  envRelayKey,
  PHONE_ENDPOINT_SQL,
  pushRelayConfig,
  RELAY_KEY_MASK,
  RELAY_PREFIX,
  RelayError,
  setRelayContent,
  setRelayKey,
  wherePhoneEndpoint
} from '../services/push-relay.js'
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
 *  POST   /push/phones        — register this phone {token | relay_device, platform?, app?,
 *                               device_name?}; `relay_device` is the Nivaro app's id at the
 *                               push relay (`relay:<id>` row); answers a one-time
 *                               `forget_key` (only its hash is stored); 401 SESSION_EXPIRED when
 *                               the sign-in ended meanwhile, 503 PUSH_RETRY when it could not be
 *                               checked (the row is taken back either way; the app retries)
 *  DELETE /push/phones        — remove one of the caller's phones {token}
 *  POST   /push/phones/forget — remove this phone {token, forget_key} WITHOUT a sign-in: the key
 *                               from its registration proves it is the phone that registered, so
 *                               a sign-out that lost its session (expired token, offline) can
 *                               still stop the alerts later; the token alone is not enough
 *  POST   /push/phones/test   — send a test alert to the current user's phones
 *  GET    /push/relay         — (admin) push relay status {connected, url, content, mode, phones}
 *  POST   /push/relay         — (admin) {connect: true} registers this instance with the relay;
 *                               {relay_key?} stores a key by hand; {content?: 'full'|'minimal'}
 */

const PHONE_ID_ERROR = 'token must be an Expo push token, or relay_device a valid device id'
const PHONE_ID_CODE = 'RELAY_DEVICE_INVALID'
const RELAY_DEVICE = /^[A-Za-z0-9_-]{16,64}$/

/** The subscription endpoint a phone request names: an Expo token or a relay device id. */
function phoneEndpoint(
  body: { token?: unknown; relay_device?: unknown } | undefined
): string | null {
  if (body?.relay_device !== undefined) {
    return typeof body.relay_device === 'string' && RELAY_DEVICE.test(body.relay_device)
      ? `${RELAY_PREFIX}${body.relay_device}`
      : null
  }
  return isExpoPushToken(body?.token) ? `${PHONE_PREFIX}${body?.token}` : null
}

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
      .select(db.raw(`CASE WHEN ${PHONE_ENDPOINT_SQL} THEN 1 ELSE 0 END as phone`))
      .count({ c: '*' })
      .groupBy(db.raw(`CASE WHEN ${PHONE_ENDPOINT_SQL} THEN 1 ELSE 0 END`))) as Array<{
      phone: number | string
      c: number | string
    }>
    const of = (phone: number) => Number(rows.find((r) => Number(r.phone) === phone)?.c ?? 0)
    // `subscriptions` stays browsers only: the browser UI reads it.
    return reply.send({ data: { subscriptions: of(0), phones: of(1) } })
  })

  app.post('/test', { preHandler: requireAuth }, async (req, reply) => {
    const sent = await sendWebPush(req.user!.id, {
      title: 'Browser notifications are on',
      body: 'This is how Nivaro will reach you when something needs you and the tab is in the background.',
      url: '/notifications',
      category: 'alerts',
      lane: 'needs_you',
      tag: 'push-test'
    })
    return reply.send({ data: { sent } })
  })

  app.get('/phones', { preHandler: requireAuth }, async (req, reply) => {
    const rows = (await wherePhoneEndpoint(
      db('nivaro_push_subscriptions').where({ user: req.user!.id })
    )
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
    Body: {
      token?: string
      relay_device?: string
      platform?: string
      app?: string
      device_name?: string
    }
  }>('/phones', { preHandler: requireAuth }, async (req, reply) => {
    const { platform, app: appId, device_name } = req.body ?? {}
    const endpoint = phoneEndpoint(req.body)
    if (!endpoint) {
      return reply.code(400).send({ error: PHONE_ID_ERROR, code: PHONE_ID_CODE })
    }
    const hash = endpointHash(endpoint)
    const plat = ['ios', 'android'].includes(String(platform)) ? String(platform) : 'unknown'
    const appKey =
      String(appId ?? '')
        .replace(/[^\w.-]/g, '')
        .slice(0, 100) || 'app'
    // A fresh secret per registration: the app keeps it to stop the alerts on sign-out without
    // a working sign-in. Stored hashed; a new registration (another person) replaces it.
    const forgetKey = randomBytes(24).toString('base64url')
    const fields = {
      user: req.user!.id,
      keys_p256dh: `expo:${forgetKeyHash(forgetKey)}`,
      keys_auth: `${plat}:${appKey}`.slice(0, 255),
      user_agent: (typeof device_name === 'string' && device_name.trim()
        ? device_name.trim()
        : String(req.headers['user-agent'] ?? '')
      ).slice(0, 500)
    }
    // A phone belongs to whoever signed in on it last: a token is the app install, not the
    // person, so a second person signing in on a shared phone takes its alerts over.
    const existing = (await db('nivaro_push_subscriptions')
      .where({ endpoint_hash: hash })
      .first('id')) as { id: number } | undefined
    let rowId = existing?.id
    if (existing) {
      await db('nivaro_push_subscriptions').where({ endpoint_hash: hash }).update(fields)
    } else {
      await db('nivaro_push_subscriptions').insert({
        ...fields,
        endpoint,
        endpoint_hash: hash,
        created_at: new Date()
      })
      rowId = (
        (await db('nivaro_push_subscriptions').where({ endpoint_hash: hash }).first('id')) as
          | { id: number }
          | undefined
      )?.id
    }
    // The credential this registration came with: the phone's sign-in, or the session. A sign-out
    // sweep keeps a row only while that credential is still signed in (services/device-grants.ts).
    const sid =
      req.authMethod === 'session'
        ? ((req.session as unknown as { sessionId?: string } | null)?.sessionId ?? null)
        : null
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const by: PushCredential | null = req.deviceGrantId
      ? `grant:${req.deviceGrantId}`
      : sid
        ? `sid:${sid}`
        : req.authMethod === 'token' && bearer
          ? staticTokenStamp(bearer)
          : req.authMethod === 'api_key' && req.apiKeyId
            ? `key:${req.apiKeyId}`
            : null
    if (rowId) {
      const id = Number(rowId)
      /** Take the row back (a refused delete is kept for a retry, services/device-grants.ts). */
      const takeBack = () => deletePushRowsOrKeep(app.redis, req.user!.id, [id], req)
      try {
        // Registered from a signed-in phone: the row ends with that sign-in.
        const noted = req.deviceGrantId
          ? await addGrantPushId(app.redis, req.deviceGrantId, id)
          : true
        await notePhoneRegistered(app.redis, id, by).catch((err) =>
          req.log.warn({ err }, 'phone push: registration not stamped')
        )
        // Re-checked AFTER the stamp: a sign-out that ended this credential meanwhile may have
        // swept before the row existed — the row goes with it, as the sweep would have taken it.
        const live = noted && (by ? await credentialLive(app.redis, by, req.user!.id) : true)
        if (!live) {
          await takeBack()
          return reply
            .code(401)
            .send({ error: 'Your sign-in has ended. Sign in again.', code: 'SESSION_EXPIRED' })
        }
      } catch (err) {
        // The note or the re-check could not run (Redis): fail closed — a row nobody can tie to a
        // live sign-in never stays. The app registers again.
        req.log.warn({ err }, 'phone push: registration not confirmed, row taken back')
        await takeBack()
        return reply.code(503).send({
          error: 'Phone alerts could not be set up just now. Try again.',
          code: 'PUSH_RETRY'
        })
      }
    }
    return reply.send({ data: { registered: true, forget_key: forgetKey } })
  })

  app.delete<{ Body: { token?: string; relay_device?: string } }>(
    '/phones',
    { preHandler: requireAuth },
    async (req, reply) => {
      const endpoint = phoneEndpoint(req.body)
      if (!endpoint) {
        return reply.code(400).send({ error: PHONE_ID_ERROR, code: PHONE_ID_CODE })
      }
      const removed = await db('nivaro_push_subscriptions')
        .where({ endpoint_hash: endpointHash(endpoint), user: req.user!.id })
        .del()
      return reply.send({ data: { removed: Number(removed) > 0 } })
    }
  )

  app.post<{ Body: { token?: string; relay_device?: string; forget_key?: string } }>(
    '/phones/forget',
    async (req, reply) => {
      const { forget_key } = req.body ?? {}
      const endpoint = phoneEndpoint(req.body)
      if (!endpoint || typeof forget_key !== 'string' || forget_key.length > 100) {
        return reply
          .code(400)
          .send({ error: 'token (or relay_device) and forget_key are required' })
      }
      const hash = endpointHash(endpoint)
      const row = (await db('nivaro_push_subscriptions')
        .where({ endpoint_hash: hash })
        .first('id', 'keys_p256dh')) as { id: number; keys_p256dh: string } | undefined
      const want = Buffer.from(String(row?.keys_p256dh ?? ''))
      const got = Buffer.from(`expo:${forgetKeyHash(forget_key)}`)
      // Same answer either way: the route says nothing about which phones are registered.
      if (row && want.length === got.length && timingSafeEqual(want, got)) {
        await db('nivaro_push_subscriptions').where({ id: row.id }).del()
        req.log.info({ phone: row.id }, 'phone push: forgotten on sign-out')
      }
      return reply.send({ data: { removed: true } })
    }
  )

  app.get('/relay', { preHandler: requireAdmin }, async (_req, reply) =>
    reply.send({ data: await relayStatus() })
  )

  app.post<{
    Body: { connect?: boolean; disconnect?: boolean; relay_key?: string; content?: string }
  }>('/relay', { preHandler: requireAdmin }, async (req, reply) => {
    const { connect, disconnect, relay_key, content } = req.body ?? {}
    if (content !== undefined && content !== 'full' && content !== 'minimal') {
      return reply
        .code(400)
        .send({ error: "content must be 'full' or 'minimal'", code: 'RELAY_CONTENT_INVALID' })
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    // Cloud provisioning owns a tenant's relay key and url (POST /admin/push-relay): an admin
    // here may choose the content, never connect, set, point elsewhere or drop the key.
    if (
      process.env.CLOUD_META_DB_URL &&
      (connect || disconnect || relay_key !== undefined || body.relay_url !== undefined)
    ) {
      return reply.code(403).send({
        error: 'The push relay is managed by Nivaro Cloud for this workspace.',
        code: 'CLOUD_MANAGED'
      })
    }
    if ((connect || typeof relay_key === 'string' || disconnect) && envRelayKey()) {
      return reply.code(409).send({
        error: 'The relay key comes from the environment (MOBILE_PUSH_RELAY_KEY) here.',
        code: 'RELAY_KEY_FROM_ENV'
      })
    }
    const changes: string[] = []
    if (content) {
      await setRelayContent(content)
      changes.push(`content=${content}`)
    }
    // The key is never sent back or logged; a masked value re-sent from a form leaves it alone.
    if (typeof relay_key === 'string' && relay_key.trim() && relay_key.trim() !== RELAY_KEY_MASK) {
      await setRelayKey(relay_key.trim())
      changes.push('key set')
    }
    if (disconnect) {
      await clearRelayKey()
      changes.push('disconnected')
    }
    if (connect) {
      try {
        await connectPushRelay(await instanceOrigin(), await instanceName())
        changes.push('connected')
      } catch (err) {
        if (err instanceof RelayError) {
          return reply.code(400).send({ error: err.message, code: err.code })
        }
        req.log.warn({ err }, 'push relay: connect failed')
        return reply
          .code(502)
          .send({ error: 'Could not connect to the push relay.', code: 'RELAY_UNAVAILABLE' })
      }
    }
    if (changes.length) {
      await logActivity({
        action: 'push-relay-update',
        user: req.user?.id,
        collection: 'nivaro_settings',
        comment: `push relay: ${changes.join(', ')}`,
        req
      })
    }
    return reply.send({ data: await relayStatus() })
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

/** The relay card's status: connection, URL, content, mode and how many phones are registered
 *  (relay and Expo rows, every person). The key itself is never part of it. */
async function relayStatus() {
  const cfg = await pushRelayConfig()
  const row = (await wherePhoneEndpoint(db('nivaro_push_subscriptions'))
    .count({ c: '*' })
    .first()
    .catch(() => null)) as { c?: number | string } | null | undefined
  return {
    connected: !!cfg.key,
    url: cfg.url,
    content: cfg.content,
    mode: await phonePushMode(),
    phones: Number(row?.c ?? 0)
  }
}

function forgetKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
