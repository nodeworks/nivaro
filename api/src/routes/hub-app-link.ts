import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { failedAuthLimiter, windowLimiter } from '../lib/auth-fail-limiter.js'
import { environmentForLinkToken } from '../services/hub/link-token.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { identityKeys, pruneSignins, recordSignin, switcherFor } from '../services/hub/signins.js'

/**
 * Hub app link (Hub side, phase 7 Decision 12/13) — what an app asks the Hub about sign-ins.
 *
 *   POST /api/hub/app-link/signins   { oid?, tid?, email? } → 204   (400 NO_IDENTITY)
 *   GET  /api/hub/app-link/switcher?oid=&tid=&email=        → { data: { apps } }
 *
 * Mounted only with HUB=on (never in cloud mode). Every request needs `Authorization: Bearer
 * <the environment's hub token>` (HUB_TOKEN on the app): found through its lookup hash and
 * confirmed timing-safe against the sealed token; an unknown, stale or shared token names no
 * environment (401 HUB_LINK_REFUSED, 429 after 20 failures a minute from one address, like
 * routes/hub-link.ts). The environment is ONLY the one the token belongs to: an app reports
 * sign-ins to its own environment and asks the switcher about its own people (a person with no
 * sign-in row there gets an empty list). The answer names apps, environment keys and each app's
 * own sign-in link; never an email, code, token or another app's data.
 *
 * Bodies are capped at 4 KB; each environment may call 1200 times a minute per process (429).
 * A report writes at most two rows (one per identity key) and repeats are idempotent.
 * POST /signins is exempt from the maintenance freeze (a bearer, never a person).
 *
 * Cron hub-signins-prune (04:10 daily) deletes rows not seen for 180 days. The scheduler fires it
 * only where crons tick (cronTicksEnabled).
 */

const HUB_LINK_REFUSED = 'HUB_LINK_REFUSED'
const BODY_LIMIT = 4096
const PER_ENV_PER_MINUTE = 1200

type Linked = { environment_id: number; app_id: number; env_key: string }

function refuse(reply: FastifyReply, status: number, message: string, code = HUB_LINK_REFUSED) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

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

export async function hubAppLinkRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  const authFails = failedAuthLimiter()
  const perEnv = windowLimiter(PER_ENV_PER_MINUTE)
  const linked = new WeakMap<FastifyRequest, Linked>()

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'Too many attempts')
    const bearer = bearerOf(req)
    let env: Linked | null = null
    if (bearer) {
      try {
        env = await environmentForLinkToken(bearer)
      } catch {
        // A database failure is not the caller's fault: not counted, fixed answer, fails closed.
        req.log.error({ route: 'hub-app-link' }, 'hub app link: token lookup failed')
        return refuse(reply, 503, 'The Hub cannot answer right now', 'HUB_LINK_UNAVAILABLE')
      }
    }
    if (!env) {
      if (authFails.fail(req.ip))
        req.log.warn({ ip: req.ip }, 'hub app link: wrong or missing hub token')
      return refuse(reply, 401, 'Unauthorized')
    }
    if (!perEnv.take(`env:${env.environment_id}`))
      return refuse(reply, 429, 'Too many requests', 'HUB_LINK_BUSY')
    linked.set(req, env)
  })

  app.post('/signins', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const env = linked.get(req)
    if (!env) return refuse(reply, 401, 'Unauthorized')
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {}
    const who = { oid: one(body.oid), tid: one(body.tid), email: one(body.email) }
    try {
      if (!identityKeys(who).length)
        return reply
          .code(400)
          .send({ error: 'No usable identity', message: 'No usable identity', code: 'NO_IDENTITY' })
      await recordSignin({
        environment_id: env.environment_id,
        app_id: env.app_id,
        via: 'direct',
        ...who
      })
    } catch {
      req.log.error({ route: 'hub-app-link-signins' }, 'hub app link: a sign-in was not recorded')
      return refuse(reply, 503, 'The Hub cannot answer right now', 'HUB_LINK_UNAVAILABLE')
    }
    return reply.code(204).send()
  })

  app.get('/switcher', async (req, reply) => {
    const env = linked.get(req)
    if (!env) return refuse(reply, 401, 'Unauthorized')
    const q = (req.query ?? {}) as Record<string, unknown>
    try {
      const apps = await switcherFor(env.env_key, env.environment_id, {
        oid: one(q.oid),
        tid: one(q.tid),
        email: one(q.email)
      })
      return reply.send({ data: { apps } })
    } catch {
      req.log.error({ route: 'hub-app-link-switcher' }, 'hub app link: switcher answer failed')
      return refuse(reply, 503, 'The Hub cannot answer right now', 'HUB_LINK_UNAVAILABLE')
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
          'Daily 04:10 (Hub only) — deletes app-switcher sign-in rows (nivaro_hub_signins) not seen for 180 days. Touches only that table.'
      }
    )
  }
}
