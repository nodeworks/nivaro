import fastifyCookie from '@fastify/cookie'
import type { FastifySessionObject } from '@fastify/session'
import fastifySession from '@fastify/session'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { config } from '../config.js'
import { withAuthDeadline } from '../services/auth-deadline.js'

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
  // #1719 — the sockets those sessions opened close too, on every replica (Redis adapter).
  // Lazy: the socket service pulls in permissions and chat, which this module must not.
  void import('../services/socket-access.js')
    .then((m) => m.endSessionSockets(sids, 'signed_out'))
    .catch(() => {})
}

/** SCAN pages (200 keys each) before sessionIdsForUser gives up: 10M keys. */
const SCAN_MAX_PAGES = 50_000

/**
 * Every live session id that belongs to `userId` (case-insensitive), by SCAN —
 * sessions are not indexed by person. Revocation markers and unparseable blobs
 * are skipped. `except` = a session id to leave out (the caller's own).
 */
export async function sessionIdsForUser(
  redis: Redis,
  userId: string,
  opts: { except?: string | null } = {}
): Promise<string[]> {
  const want = String(userId).toUpperCase()
  const out: string[] = []
  let cursor = '0'
  let guard = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 200)
    cursor = next
    const live = keys.filter((k) => !k.startsWith(REVOKED_PREFIX))
    if (live.length > 0) {
      const values = await redis.mget(...live)
      live.forEach((key, i) => {
        const raw = values[i]
        if (!raw) return
        try {
          const uid = (JSON.parse(raw) as { userId?: string }).userId
          const sid = key.slice('sess:'.length)
          if (uid && String(uid).toUpperCase() === want && sid !== opts.except) out.push(sid)
        } catch {
          /* unparseable session blob — not attributable to anyone */
        }
      })
    }
    guard++
    // SCAN always comes back to '0'; the cap only stops a store that never does.
    // Fail closed: a partial list would let a caller report "signed out" while
    // some of the person's sessions still work.
    if (cursor !== '0' && guard >= SCAN_MAX_PAGES)
      throw new Error('The session scan did not finish — not every session was found')
  } while (cursor !== '0')
  return out
}

/** Sign one person out of every session (but `except`), on every app and tab:
 *  revoked, never a bare DEL, and their sockets close (`revokeSessions`). */
export async function revokeUserSessions(
  redis: Redis,
  userId: string,
  opts: { except?: string | null } = {}
): Promise<number> {
  const sids = await sessionIdsForUser(redis, userId, opts)
  await revokeSessions(redis, sids)
  return sids.length
}

export function buildRedisStore(redis: Redis) {
  return {
    get(sid: string, callback: (err: unknown, session: FastifySessionObject | null) => void) {
      // Time-limited (services/auth-deadline.ts): a Redis that stops answering fails the
      // request with 503 instead of holding it open in its first hook forever.
      withAuthDeadline(
        redis.mget(`sess:${sid}`, `${REVOKED_PREFIX}${sid}`),
        'the session store'
      ).then(
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

/** The session cookie's name (the Traffic Map's temporary cache recognises it, #2273). */
export const SESSION_COOKIE = 'nivaro_session'

export async function registerSession(app: FastifyInstance) {
  await app.register(fastifyCookie)
  await app.register(fastifySession, {
    secret: config.SESSION_SECRET,
    cookieName: SESSION_COOKIE,
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
