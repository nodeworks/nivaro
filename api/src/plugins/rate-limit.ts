import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

/**
 * Redis-backed fixed-window rate limiter for /api routes.
 *
 * - Window: 60s, keyed per user (authenticated) or bearer-token hash or IP.
 * - Limit: RATE_LIMIT_PER_MINUTE env (default 1000).
 * - Headers: X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset
 *   on every /api response; 429 + Retry-After when exceeded.
 * - Skips /api/health. Fails open on Redis errors.
 *
 * Register AFTER redisPlugin (uses app.redis).
 */

const WINDOW_SECONDS = 60

function resolveLimit(): number {
  const raw = Number(process.env.RATE_LIMIT_PER_MINUTE)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1000
}

function clientKey(req: {
  user?: { id: string }
  headers: Record<string, string | string[] | undefined>
  ip: string
}): string {
  if (req.user?.id) return `u:${req.user.id}`
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth) {
    return `t:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`
  }
  return `ip:${req.ip}`
}

export const rateLimitPlugin = fp(async (app: FastifyInstance) => {
  const limit = resolveLimit()

  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? ''
    if (!url.startsWith('/api/') && url !== '/api') return
    if (url === '/api/health' || url.startsWith('/api/health?')) return

    const nowSec = Math.floor(Date.now() / 1000)
    const windowStart = Math.floor(nowSec / WINDOW_SECONDS) * WINDOW_SECONDS
    const resetAt = windowStart + WINDOW_SECONDS
    const key = `rl:${windowStart}:${clientKey(req)}`

    let count: number
    try {
      const results = await app.redis
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
      reply.header('Retry-After', String(Math.max(resetAt - nowSec, 1)))
      return reply.code(429).send({
        error: 'Too Many Requests',
        retry_after: Math.max(resetAt - nowSec, 1)
      })
    }
  })

  app.log.info({ limit }, 'Rate limiter ready (fixed window, per minute)')
})
