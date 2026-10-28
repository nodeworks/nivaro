import fastifyCookie from '@fastify/cookie'
import type { Redis } from 'ioredis'
import { REVOKED_PREFIX, SESSION_COOKIE } from '../auth/session.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * The session cookie a same-origin socket handshake carried (A2, review 2026-10-27).
 *
 * Every app signs its socket in with `auth {token}` (a one-time ws token). A small UI bundle
 * that only opens a socket and asks for its tenant room (`tenant:join`, the cloud billing
 * bundle) has no token to send; its handshake still carries the session cookie when it
 * connects to its own origin. This reads that cookie the way @fastify/session does — signed
 * id, Redis `sess:<id>`, revocation marker, active account, session policy — so `tenant:join`
 * can accept such a socket without signing it in for anything else.
 *
 * Same origin only: a handshake whose Origin names another host (a page elsewhere opening a
 * socket with the visitor's cookie — cross-site WebSocket hijacking) is refused unless that
 * origin is in CORS_ORIGINS.
 */

export interface HandshakeLike {
  handshake?: { headers?: Record<string, unknown> }
}

function header(h: Record<string, unknown> | undefined, name: string): string {
  const v = h?.[name]
  if (Array.isArray(v)) return String(v[0] ?? '')
  return typeof v === 'string' ? v : ''
}

/** Is the handshake's Origin (when it sent one) this host or an allowed CORS origin? */
export function handshakeOriginAllowed(
  headers: Record<string, unknown> | undefined,
  allowList: string[] = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
): boolean {
  const origin = header(headers, 'origin')
  if (!origin) return true // not a browser page: nothing can ride someone else's cookie
  if (allowList.includes(origin)) return true
  let originHost: string
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }
  const hosts = [header(headers, 'x-forwarded-host'), header(headers, 'host')]
    .flatMap((h) => h.split(','))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return hosts.includes(originHost)
}

/** The session id a signed `nivaro_session` cookie names, or null. */
export function sessionIdFromCookie(
  cookieHeader: string,
  secret: string = config.SESSION_SECRET
): string | null {
  if (!cookieHeader) return null
  let raw: string | undefined
  try {
    raw = fastifyCookie.fastifyCookie.parse(cookieHeader)[SESSION_COOKIE]
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const signer = new fastifyCookie.Signer(secret, 'sha256')
    const res = signer.unsign(raw)
    return res.valid && res.value ? res.value : null
  } catch {
    return null
  }
}

export interface HandshakeSession {
  user: User
  sid: string
}

/**
 * The signed-in person behind a handshake's session cookie, or null (no cookie, a bad
 * signature, another origin, a gone / revoked / expired session, an inactive account).
 * Runs in the caller's tenant context (the account is read from that tenant's database).
 */
export async function handshakeSessionUser(
  socket: HandshakeLike,
  redis: Pick<Redis, 'mget'> | null | undefined
): Promise<HandshakeSession | null> {
  if (!redis) return null
  const headers = socket.handshake?.headers
  if (!handshakeOriginAllowed(headers)) return null
  const sid = sessionIdFromCookie(header(headers, 'cookie'))
  if (!sid) return null
  try {
    const [raw, revoked] = await redis.mget(`sess:${sid}`, `${REVOKED_PREFIX}${sid}`)
    if (!raw || revoked) return null
    const session = JSON.parse(raw) as { userId?: string; loginAt?: number; lastSeenAt?: number }
    if (!session.userId) return null
    const user = (await db<User>('nivaro_users')
      .where({ id: session.userId, status: 'active' })
      .first()) as (User & { is_redacted?: boolean | number | null }) | undefined
    if (!user || user.is_redacted === true || user.is_redacted === 1) return null
    const { getSessionPolicy, limitsFor, judgeSession } = await import('./session-policy.js')
    const policy = await getSessionPolicy()
    if (policy) {
      const verdict = judgeSession(
        limitsFor(policy, user.role as string | null),
        { loginAt: session.loginAt, lastSeenAt: session.lastSeenAt },
        Date.now()
      )
      if (!verdict.ok) return null
    }
    return { user, sid }
  } catch {
    return null
  }
}
