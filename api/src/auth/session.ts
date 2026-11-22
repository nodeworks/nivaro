import fastifyCookie from '@fastify/cookie'
import type { FastifySessionObject } from '@fastify/session'
import fastifySession from '@fastify/session'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { config } from '../config.js'
import { getTenantId } from '../db/tenant-context.js'
import { withAuthDeadline } from '../services/auth-deadline.js'
import { tenantSource } from '../services/deployment-mode.js'

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

// ─── One app per session on a Hub shared deployment (ruling P5-16) ─────────
// A shared deployment serves many apps from one process, one Redis and one SESSION_SECRET, and
// its apps are often copies of each other (dev, staging and production share user ids). A
// session therefore carries the app it belongs to (`tenantId`, stamped on every save and at
// every sign-in) and is never read, written, listed or revoked by another app: the store hands
// another app's session (or one with no stamp) to a request as "no session". Cloud and
// self-hosted never stamp and never refuse (tenantSource() is not 'hub' there).

/** The app a request on a shared deployment belongs to ('' none); null off a shared deployment. */
function sharedSessionApp(): string | null {
  return tenantSource() === 'hub' ? (getTenantId() ?? '') : null
}

/** True when a stored session blob must not be used by this request: on a Hub shared
 *  deployment, a session of another app, one with no app stamp, or a request with no app.
 *  Always false in cloud and self-hosted. */
export function sessionForeign(blob: unknown): boolean {
  const here = sharedSessionApp()
  if (here === null) return false
  const stamp = (blob as { tenantId?: unknown } | null | undefined)?.tenantId
  return !here || typeof stamp !== 'string' || stamp !== here
}

/** Stamp the request's app on its session (sign-in). No-op off a shared deployment. */
export function stampSessionApp(session: { tenantId?: string }): void {
  const here = sharedSessionApp()
  if (here) session.tenantId = here
}

/** Revoke session ids so no in-flight request can resurrect them. */
export async function revokeSessions(
  redis: Redis,
  sids: string[],
  ttlSeconds = config.SESSION_TTL
): Promise<void> {
  if (sids.length === 0) return
  // Realtime round 9: whose sessions these are, read before they go (the live sessions list on
  // the person page). Best-effort — a read that fails never stops the revoke.
  let owners: string[] = []
  try {
    owners = sessionOwners(await redis.mget(...sids.map((sid) => `sess:${sid}`)))
  } catch {
    owners = []
  }
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
  // Administrators with these people's page open see the session go (the person's id only).
  if (owners.length > 0)
    void import('../services/sessions-live.js')
      .then((m) => m.noteSessionsChanged(owners))
      .catch(() => {})
}

/** The signed-in people a list of session blobs (raw JSON, null = gone) belongs to. */
export function sessionOwners(raws: Array<string | null | undefined> | null | undefined): string[] {
  const out: string[] = []
  for (const raw of raws ?? []) {
    if (typeof raw !== 'string' || !raw) continue
    try {
      const uid = (JSON.parse(raw) as { userId?: unknown }).userId
      if (typeof uid === 'string' && uid) out.push(uid)
    } catch {
      /* unparseable blob — nobody to tell */
    }
  }
  return out
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
          const blob = JSON.parse(raw) as { userId?: string }
          const uid = blob.userId
          const sid = key.slice('sess:'.length)
          // Shared deployment: only this app's sessions (another app may hold the same user id).
          if (sessionForeign(blob)) return
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
 *  revoked, never a bare DEL, and their sockets close (`revokeSessions`). Their phones too
 *  (but `exceptDeviceGrant`, the calling phone's own sign-in): each device grant ends with its
 *  push rows (services/device-grants.ts). Returns sessions + phones signed out. */
export async function revokeUserSessions(
  redis: Redis,
  userId: string,
  opts: {
    except?: string | null
    exceptDeviceGrant?: string | null
    /** false = a partial sign-out (everywhere else, an admin's session sign-out): phone rows a
     *  static token or API key registered stay while that credential works. Default full. */
    full?: boolean
  } = {}
): Promise<number> {
  const sids = await sessionIdsForUser(redis, userId, opts)
  await revokeSessions(redis, sids)
  // Loaded on use: this module sits under every request, the device-grant service on the db.
  const { endUserDeviceGrants } = await import('../services/device-grants.js')
  // Sessions are ended above, phones here; then the person's phone push rows are swept, keeping
  // only the caller's own ("everywhere else": the kept session's or phone's rows).
  const phones = await endUserDeviceGrants(redis, userId, {
    except: opts.exceptDeviceGrant,
    keepSid: opts.except,
    ...(opts.full === false ? { full: false } : {})
  })
  return sids.length + phones
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
        ([raw, revoked]) => {
          const blob = raw && !revoked ? (JSON.parse(raw) as FastifySessionObject) : null
          // Shared deployment (P5-16): another app's session reads as no session at all, so this
          // request gets a fresh one and the other app's session is neither used nor written.
          callback(null, blob && !sessionForeign(blob) ? blob : null)
        },
        (err) => callback(err, null)
      )
    },
    set(sid: string, session: FastifySessionObject, callback: (err?: unknown) => void) {
      // Shared deployment (P5-16): every saved session names its app (pre-sign-in state such
      // as the OIDC state included); a request with no app stores none.
      const here = sharedSessionApp()
      if (here === '') {
        callback()
        return
      }
      if (here !== null) (session as { tenantId?: string }).tenantId = here
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

/** Session fields a sign-in carries into the new session id (where to go next). */
const CARRIED_ON_SIGN_IN = ['returnTo'] as const

/**
 * Every sign-in gets a NEW session id (security audit M13, session fixation): a session id
 * planted before sign-in (or seen while signed out) never becomes a signed-in one. The old id
 * is revoked so a copy of it reads as "no session". Only `returnTo` is carried over; the
 * caller then stamps userId / authAt on the new session. A store that refuses the new id
 * fails the sign-in rather than continuing on the old one.
 */
export async function regenerateForSignIn(
  req: FastifyRequest,
  redis: Redis | null | undefined
): Promise<void> {
  const oldSid = req.session.sessionId
  await req.session.regenerate([...CARRIED_ON_SIGN_IN])
  if (oldSid && redis && oldSid !== req.session.sessionId) {
    await revokeSessions(redis, [oldSid]).catch(() => {})
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
      // On by default when PUBLIC_URL / ADMIN_URL is https (config.ts → resolveCookieSecure).
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
