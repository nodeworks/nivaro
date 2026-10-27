import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { entityBreakerHook, startBreakerSync } from '../services/traffic-breaker.js'

/**
 * Redis-backed fixed-window rate limits for /api routes (60 s windows).
 *
 * Two layers, both registered AFTER the session plugin so a caller is keyed by WHO they
 * verifiably are, not by a credential they merely sent (M15, security audit 2026-10-27):
 *
 * 1. Anonymous limit — ON by default (RATE_LIMIT_ANON_PER_MINUTE, default 300; 0 = off).
 *    Keyed per client IP (req.ip, i.e. after TRUST_PROXY). Every response that ends with no
 *    signed-in caller (no verified session, no authenticated principal) counts against its
 *    IP; once over, that IP's requests without a verified session are refused — bearer
 *    requests too, so guessing tokens from one address is capped. Signed-in traffic never
 *    counts, so a busy record page is never refused by it.
 * 2. Per-caller limit — OFF unless RATE_LIMIT_PER_MINUTE is set (> 0). Nivaro ships with no
 *    per-caller limit (2026-09-14 — the old 1000/min default 429'd real record pages: a large
 *    record form is 100+ requests). Keyed by the verified session user, else the bearer
 *    token's hash, else the IP. Named API keys keep their own per-key `rate_limit`, enforced
 *    in authenticate.
 *
 * Headers: X-RateLimit-Limit / -Remaining / -Reset from the per-caller limit; 429 +
 * Retry-After when either is exceeded. Skips /api/health, /api/ready, /api/version and the
 * render peer, the Teams bot endpoint and webhook flows (self-authenticating machine callers);
 * in-process (inject) calls are never counted. Keys carry the tenant in cloud
 * mode. Fails open on Redis errors.
 *
 * `rateLimitPlugin` (registered early) holds the Traffic Map entity breakers;
 * `callerRateLimitPlugin` (after registerSession) holds both limits. Both need app.redis.
 */

const WINDOW_SECONDS = 60

function registerEntityBreakers(app: FastifyInstance): void {
  if (process.env.CLOUD_META_DB_URL) return
  startBreakerSync((app as unknown as { redis?: Parameters<typeof startBreakerSync>[0] }).redis)
  app.addHook('onRequest', async (req, reply) => {
    if (await entityBreakerHook(req, reply)) return reply
  })
}

/** 0 = disabled (the default). */
export function resolveLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RATE_LIMIT_PER_MINUTE)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

/** Anonymous requests per IP per minute; default 300, 0 = off. */
export function resolveAnonLimit(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.RATE_LIMIT_ANON_PER_MINUTE
  if (v === undefined || String(v).trim() === '') return 300
  const raw = Number(v)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

interface LimitedRequest {
  user?: { id: string } | null
  session?: { userId?: unknown } | null
  headers: Record<string, string | string[] | undefined>
  ip: string
}

/** The verified session's user id, or null (a cookie alone proves nothing). */
export function sessionUser(req: { session?: { userId?: unknown } | null }): string | null {
  const id = req.session?.userId
  return typeof id === 'string' && id ? id : null
}

/** Per-caller key: verified user, else bearer hash, else IP. */
export function clientKey(req: LimitedRequest): string {
  const uid = req.user?.id ?? sessionUser(req)
  if (uid) return `u:${String(uid).toUpperCase()}`
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth) {
    return `t:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`
  }
  return `ip:${req.ip}`
}

const EXEMPT = [/^\/api\/health([/?]|$)/, /^\/api\/ready([/?]|$)/, /^\/api\/version([/?]|$)/]

/** Is this request outside the limits altogether? */
export function exemptFromLimits(req: {
  raw: { url?: string }
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string } | null
}): boolean {
  const url = req.raw.url ?? ''
  if (!url.startsWith('/api/') && url !== '/api') return true
  if (EXEMPT.some((re) => re.test(url))) return true
  // The render peer (#2789): one caller (the slim process) on behalf of everyone.
  if (url.startsWith('/api/internal/render/')) return true
  // Machine callers that sign every request themselves and arrive from a few shared
  // addresses: Microsoft's Bot Connector (signed JWT) and partner webhook flows (secret).
  if (url.startsWith('/api/teams/messages') || url.startsWith('/api/flows/webhook/')) return true
  // In-process app.inject calls (MCP tool calls, auto-PDF) and probes from inside the
  // container: a loopback socket that no proxy forwarded. (Never a header the client sets.)
  if (isLoopback(req.socket?.remoteAddress) && !req.headers['x-forwarded-for']) return true
  return false
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

function tenantPart(): string {
  const t = currentTenantKey()
  return t ? `${t}:` : ''
}

function windowNow() {
  const nowSec = Math.floor(Date.now() / 1000)
  const windowStart = Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS
  return { nowSec, windowStart, resetAt: windowStart + WINDOW_SECONDS }
}

function tooMany(reply: FastifyReply, wait: number, message: string): FastifyReply {
  reply.header('Retry-After', String(wait))
  return reply.code(429).send({
    statusCode: 429,
    error: 'Too Many Requests',
    message,
    code: 'RATE_LIMITED',
    retry_after: wait
  })
}

interface RedisMulti {
  incr(key: string): RedisMulti
  expire(key: string, s: number): RedisMulti
  exec(): Promise<Array<[Error | null, unknown]> | null>
}
interface RedisLike {
  get(key: string): Promise<string | null>
  multi(): RedisMulti
}

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  // Traffic Map circuit breakers (#1157) on entities — independent of the rate limits.
  registerEntityBreakers(app)
})

export const callerRateLimitPlugin = fp(async (app: FastifyInstance) => {
  const limit = resolveLimit()
  const anonLimit = resolveAnonLimit()
  const redis = () => (app as unknown as { redis?: RedisLike }).redis

  if (anonLimit > 0) {
    const anonKey = (req: FastifyRequest, windowStart: number) =>
      `rl:anon:${tenantPart()}${windowStart}:${req.ip}`

    app.addHook('onRequest', async (req, reply) => {
      if (exemptFromLimits(req) || sessionUser(req)) return
      const r = redis()
      if (!r) return
      const { nowSec, windowStart, resetAt } = windowNow()
      let count: number
      try {
        count = Number(await r.get(anonKey(req, windowStart)))
      } catch {
        return // fail open
      }
      if (!Number.isFinite(count) || count < anonLimit) return
      const wait = Math.max(resetAt - nowSec, 1)
      return tooMany(
        reply,
        wait,
        `Too many requests from this address without signing in. Try again in ${wait} seconds.`
      )
    })

    // Counted once the answer is known: a request that ended with no signed-in caller
    // (anonymous, or a credential that did not check out) spends this IP's budget.
    app.addHook('onResponse', async (req) => {
      if (exemptFromLimits(req) || sessionUser(req) || req.user) return
      const r = redis()
      if (!r) return
      const { windowStart } = windowNow()
      const key = anonKey(req, windowStart)
      try {
        await r
          .multi()
          .incr(key)
          .expire(key, WINDOW_SECONDS + 5)
          .exec()
      } catch {
        /* fail open */
      }
    })
    app.log.info({ limit: anonLimit }, 'Anonymous rate limit ready (per IP, per minute)')
  }

  if (limit <= 0) {
    app.log.info('Per-caller rate limit off (set RATE_LIMIT_PER_MINUTE to enable)')
    return
  }

  app.addHook('onRequest', async (req, reply) => {
    if (exemptFromLimits(req)) return
    const r = redis()
    if (!r) return
    const { nowSec, windowStart, resetAt } = windowNow()
    const key = `rl:${tenantPart()}${windowStart}:${clientKey(req)}`

    let count: number
    try {
      const results = await r
        .multi()
        .incr(key)
        .expire(key, WINDOW_SECONDS + 5)
        .exec()
      count = Number(results?.[0]?.[1] ?? 0)
      if (!Number.isFinite(count) || count <= 0) return // fail open
    } catch {
      return // fail open — Redis unavailable must not take the API down
    }

    const remaining = Math.max(limit - count, 0)
    reply.header('X-RateLimit-Limit', String(limit))
    reply.header('X-RateLimit-Remaining', String(remaining))
    reply.header('X-RateLimit-Reset', String(resetAt))

    if (count > limit) {
      const wait = Math.max(resetAt - nowSec, 1)
      return tooMany(
        reply,
        wait,
        `This instance allows ${limit} requests per minute per caller. Try again in ${wait} seconds.`
      )
    }
  })

  app.log.info({ limit }, 'Per-caller rate limit ready (fixed window, per minute)')
})
