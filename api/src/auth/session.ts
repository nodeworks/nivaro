import fastifyCookie from '@fastify/cookie'
import type { FastifySessionObject } from '@fastify/session'
import fastifySession from '@fastify/session'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { config } from '../config.js'

// Logout must hold against the rolling save: `rolling: true` re-saves every
// request's session at response end, so a request from ANOTHER tab that
// loaded the session before a logout writes it straight back afterwards
// (two apps share the one cookie — the admin SPA and the portal). Every
// destroy therefore leaves a revocation marker for that session id; a save
// against a revoked id is a no-op (atomic — one Lua call), and a read of a
// revoked id answers "no session", so the plugin mints a fresh id on the next
// request and a new login is never blocked.
export const REVOKED_PREFIX = 'sess:revoked:'
const SET_UNLESS_REVOKED = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SETEX', KEYS[1], ARGV[1], ARGV[2])
return 1`

/** Revoke session ids so no in-flight request can resurrect them. */
export async function revokeSessions(
  redis: Redis,
  sids: string[],
  ttlSeconds = config.SESSION_TTL
): Promise<void> {
  if (sids.length === 0) return
  const pipe = redis.multi()
  for (const sid of sids) {
    pipe.del(`sess:${sid}`)
    pipe.setex(`${REVOKED_PREFIX}${sid}`, ttlSeconds, '1')
  }
  await pipe.exec()
}

export function buildRedisStore(redis: Redis) {
  return {
    get(sid: string, callback: (err: unknown, session: FastifySessionObject | null) => void) {
      redis.mget(`sess:${sid}`, `${REVOKED_PREFIX}${sid}`).then(
        ([raw, revoked]) =>
          callback(null, raw && !revoked ? (JSON.parse(raw) as FastifySessionObject) : null),
        (err) => callback(err, null)
      )
    },
    set(sid: string, session: FastifySessionObject, callback: (err?: unknown) => void) {
      redis
        .eval(
          SET_UNLESS_REVOKED,
          2,
          `sess:${sid}`,
          `${REVOKED_PREFIX}${sid}`,
          config.SESSION_TTL,
          JSON.stringify(session)
        )
        .then(
          () => callback(),
          (err) => callback(err)
        )
    },
    destroy(sid: string, callback: (err?: unknown) => void) {
      revokeSessions(redis, [sid]).then(
        () => callback(),
        (err) => callback(err)
      )
    }
  }
}

export async function registerSession(app: FastifyInstance) {
  await app.register(fastifyCookie)
  await app.register(fastifySession, {
    secret: config.SESSION_SECRET,
    cookieName: 'nivaro_session',
    cookie: {
      secure: config.COOKIE_SECURE,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.SESSION_TTL * 1000
    },
    store: buildRedisStore(app.redis) as Parameters<typeof fastifySession>[1]['store'],
    rolling: true,
    saveUninitialized: false
  })
}
