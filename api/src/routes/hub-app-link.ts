import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { failedAuthLimiter, windowLimiter } from '../lib/auth-fail-limiter.js'
import { noteClientCredentialAccepted } from '../lib/client-credential.js'
import { environmentForLinkToken } from '../services/hub/link-token.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { identityKeys, pruneSignins, recordSignin, switcherFor } from '../services/hub/signins.js'

/**
 * Hub app link (Hub side, phase 7 Decision 12/13) — what an app asks the Hub about sign-ins.
 *
 *   POST /api/hub/app-link/signins   { oid?, tid?, email? } → 204   (400 NO_IDENTITY)
 *   POST /api/hub/app-link/switcher  { oid?, tid?, email? } → { data: { apps } }
 *
 * The switcher is a POST so the person's identity never sits in a URL (proxy and access logs);
 * it is a read and writes nothing.
 *
 * Mounted only with HUB=on (never in cloud mode). Every request needs `Authorization: Bearer
 * <the environment's hub token>` (HUB_TOKEN on the app): found through its lookup hash and
 * confirmed timing-safe against the sealed token; an unknown, stale or shared token names no
 * environment (401 HUB_LINK_REFUSED). The failure brake counts per PRESENTED token (20 a minute,
 * then that token answers 429 without a lookup) and per address only with a generous ceiling
 * (FAILS_PER_ADDRESS a minute, or 20 calls with no bearer): every app of a Hub shared deployment
 * calls from the same address, each with its own token, so one app's stale token (rotated, list
 * not re-read yet) never locks the other apps out (0.3.215, review L3). Tokens are 32+ random
 * characters, so the ceiling still stops any guessing. A token whose environment is archived or suspended is refused too (401,
 * not counted: that app is not guessing). The environment is ONLY the one the token belongs to:
 * an app reports sign-ins to its own environment and asks the switcher about its own people.
 * The switcher answers only about a person the Hub itself recorded there (services/hub/signins.ts,
 * ruling P7-8): an app's reports never prove anyone. The answer names apps, environment keys and
 * each app's own sign-in link; never an email, code, token or another app's data.
 *
 * Limits (per process): bodies 4 KB; 1200 calls a minute per environment; reports 120 a minute
 * per environment; NEW identities 5000 a day per environment (Redis counter
 * nvr:hub:signins:new:<envId>:<yyyymmdd>, UTC day) — past it a report answers 429 HUB_LINK_BUSY
 * and writes nothing. A report writes at most two rows and moves an existing row on at most once
 * per 6 h. Both POSTs are exempt from the maintenance freeze (a bearer, never a person).
 *
 * Cron hub-signins-prune (04:10 daily) deletes rows not seen for 180 days, in batches. The
 * scheduler fires it only where crons tick (cronTicksEnabled).
 */

const HUB_LINK_REFUSED = 'HUB_LINK_REFUSED'
/** Failed bearers a minute from one address before it is refused (many apps share one). */
export const FAILS_PER_ADDRESS = 300
/** Failed tries a minute of one presented token (or of calls with no bearer, per address). */
const FAILS_PER_TOKEN = 20
const BODY_LIMIT = 4096
const PER_ENV_PER_MINUTE = 1200
const REPORTS_PER_ENV_PER_MINUTE = 120
export const NEW_IDENTITIES_PER_DAY = 5000
const NEW_COUNTER_TTL_S = 2 * 86_400
const CLOSED_STATUSES = new Set(['archived', 'suspended'])

type Linked = { environment_id: number; app_id: number; env_key: string }

function refuse(reply: FastifyReply, status: number, message: string, code = HUB_LINK_REFUSED) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

const unavailable = (reply: FastifyReply) =>
  refuse(reply, 503, 'The Hub cannot answer right now', 'HUB_LINK_UNAVAILABLE')
const busy = (reply: FastifyReply) => refuse(reply, 429, 'Too many requests', 'HUB_LINK_BUSY')

function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string' || !/^Bearer\s+/i.test(h)) return null
  const t = h.replace(/^Bearer\s+/i, '').trim()
  return t || null
}

/** A single text value (≤ 400 characters) or undefined; arrays and objects read as missing. */
function one(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 400 ? v : undefined
}

function whoOf(body: unknown): { oid?: string; tid?: string; email?: string } {
  const b =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  return { oid: one(b.oid), tid: one(b.tid), email: one(b.email) }
}

/** The new-identity counter for an environment and UTC day. */
export function newIdentityCounterKey(envId: number, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  return `nvr:hub:signins:new:${envId}:${day}`
}

export async function hubAppLinkRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  const addressFails = failedAuthLimiter(FAILS_PER_ADDRESS)
  const tokenFails = failedAuthLimiter(FAILS_PER_TOKEN)
  /** The brake key of a presented bearer (a short hash, never the token), or of its absence. */
  const failKey = (bearer: string | null, ip: string) =>
    bearer ? `t:${createHash('sha256').update(bearer).digest('hex').slice(0, 32)}` : `none:${ip}`
  const perEnv = windowLimiter(PER_ENV_PER_MINUTE)
  const reportsPerEnv = windowLimiter(REPORTS_PER_ENV_PER_MINUTE)
  const linked = new WeakMap<FastifyRequest, Linked>()

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const bearer = bearerOf(req)
    const key = failKey(bearer, req.ip)
    if (addressFails.blocked(req.ip) || tokenFails.blocked(key))
      return refuse(reply, 429, 'Too many attempts')
    let env: Awaited<ReturnType<typeof environmentForLinkToken>> = null
    if (bearer) {
      try {
        env = await environmentForLinkToken(bearer)
      } catch {
        // A database failure is not the caller's fault: not counted, fixed answer, fails closed.
        req.log.error({ route: 'hub-app-link' }, 'hub app link: token lookup failed')
        return unavailable(reply)
      }
    }
    if (!env) {
      const first = tokenFails.fail(key)
      if (addressFails.fail(req.ip) || first)
        req.log.warn({ ip: req.ip }, 'hub app link: wrong or missing hub token')
      return refuse(reply, 401, 'Unauthorized')
    }
    // A real hub token: never spends this address's anonymous budget (P7-15).
    noteClientCredentialAccepted(req)
    // A real token of an environment taken out of service: refused, nothing written.
    if (CLOSED_STATUSES.has(env.status)) return refuse(reply, 401, 'Unauthorized')
    if (!perEnv.take(`env:${env.environment_id}`)) return busy(reply)
    linked.set(req, {
      environment_id: env.environment_id,
      app_id: env.app_id,
      env_key: env.env_key
    })
  })

  app.post('/signins', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const env = linked.get(req)
    if (!env) return refuse(reply, 401, 'Unauthorized')
    const who = whoOf(req.body)
    if (!identityKeys(who).length)
      return reply
        .code(400)
        .send({ error: 'No usable identity', message: 'No usable identity', code: 'NO_IDENTITY' })
    if (!reportsPerEnv.take(`env:${env.environment_id}`)) return busy(reply)

    const counterKey = newIdentityCounterKey(env.environment_id)
    try {
      const seenToday = Number((await app.redis.get(counterKey)) ?? 0)
      if (seenToday >= NEW_IDENTITIES_PER_DAY) return busy(reply)
    } catch {
      req.log.error({ route: 'hub-app-link-signins' }, 'hub app link: the daily cap is unreadable')
      return unavailable(reply)
    }

    let inserted = 0
    try {
      ;({ inserted } = await recordSignin({
        environment_id: env.environment_id,
        app_id: env.app_id,
        via: 'direct',
        ...who
      }))
    } catch {
      req.log.error({ route: 'hub-app-link-signins' }, 'hub app link: a sign-in was not recorded')
      return unavailable(reply)
    }
    if (inserted) {
      try {
        await app.redis.incrby(counterKey, inserted)
        await app.redis.expire(counterKey, NEW_COUNTER_TTL_S)
      } catch {
        req.log.warn(
          { route: 'hub-app-link-signins' },
          'hub app link: the daily cap was not counted'
        )
      }
    }
    return reply.code(204).send()
  })

  app.post('/switcher', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const env = linked.get(req)
    if (!env) return refuse(reply, 401, 'Unauthorized')
    try {
      const apps = await switcherFor(env.env_key, env.environment_id, whoOf(req.body))
      return reply.send({ data: { apps } })
    } catch {
      req.log.error({ route: 'hub-app-link-switcher' }, 'hub app link: switcher answer failed')
      return unavailable(reply)
    }
  })

  if (app.cron) {
    app.cron.schedule(
      'hub-signins-prune',
      '10 4 * * *',
      async () => {
        const n = await pruneSignins()
        app.log.info(`hub-signins-prune: ${n} sign-in rows older than 180 days removed`)
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Daily 04:10 (Hub only) — deletes app-switcher sign-in rows (nivaro_hub_signins) not seen for 180 days, at most 1000 rows per statement. Touches only that table.'
      }
    )
  }
}
