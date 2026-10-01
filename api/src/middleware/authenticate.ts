import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { touchMasqueradeMarker } from '../services/masquerade-marker.js'
import { scopeAllows, scopesAreOpen } from '../services/permissions.js'
import { setTraceUser, span } from '../services/request-trace.js'
import { callerBreakerCheck } from '../services/traffic-breaker.js'
import type { Role, User } from '../types.js'

export interface ApiKeyScope {
  collection: string
  actions: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the request authenticated via a named API key (nvk_*). */
    apiKeyScopes?: ApiKeyScope[]
    /** Numeric per-minute rate limit configured on the API key, if any. */
    apiKeyRateLimit?: number | null
    apiKeyId?: number | null
    /** Set when an admin runs a request AS an API key (nvq_*): the key whose
     *  scopes, restrictions, depth cap and sandbox flag bound this request.
     *  Never attributed to the key in the request log or its usage stamps. */
    apiKeySimulatedId?: number | null
    /** Set when the request authenticated via a masquerade token (nvm_*) — the admin who issued it. */
    masqueradeAdminId?: string
    /**
     * How this request authenticated — stamped by `authenticate` so the API
     * logger can tell an integration's token call from a person's session.
     */
    authMethod?: 'session' | 'token' | 'api_key' | 'masquerade' | 'key_sim'
  }
}

/**
 * Every refusal carries a machine code beside its sentence, so a caller can
 * tell an expired key from a blocked address from a missing scope without
 * reading prose — and so the request log can group failures by cause.
 */
function httpError(
  statusCode: number,
  message: string,
  code?: string
): Error & { statusCode: number; code?: string } {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) })
}

const KEY_WINDOW_SECONDS = 60

/**
 * Per-key request limit. `rate_limit_per_minute` was stored on the key and
 * read onto the request, and nothing ever counted against it. A fixed
 * one-minute window in Redis; over the limit the caller gets 429 with
 * Retry-After. Redis trouble lets the request through — a counter that
 * cannot be read must not take an integration down.
 */
async function enforceKeyRateLimit(
  req: FastifyRequest,
  reply: FastifyReply,
  keyId: string | number,
  limit: number
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000)
  const windowStart = Math.floor(nowSec / KEY_WINDOW_SECONDS) * KEY_WINDOW_SECONDS
  const resetAt = windowStart + KEY_WINDOW_SECONDS
  let count = 0
  try {
    const results = await req.server.redis
      .multi()
      .incr(`nvr:keyrl:${keyId}:${windowStart}`)
      .expire(`nvr:keyrl:${keyId}:${windowStart}`, KEY_WINDOW_SECONDS + 5)
      .exec()
    count = Number(results?.[0]?.[1] ?? 0)
  } catch {
    return
  }
  if (!Number.isFinite(count) || count <= 0) return
  void reply.header('X-RateLimit-Limit', String(limit))
  void reply.header('X-RateLimit-Remaining', String(Math.max(limit - count, 0)))
  void reply.header('X-RateLimit-Reset', String(resetAt))
  if (count > limit) {
    const wait = Math.max(resetAt - nowSec, 1)
    void reply.header('Retry-After', String(wait))
    throw httpError(
      429,
      `This API key is limited to ${limit} requests per minute. Try again in ${wait} seconds.`,
      'API_KEY_RATE_LIMITED'
    )
  }
}

/** nivaro_users.last_access used to be written ONLY at OIDC login, so a
 *  7-day session or a static-token user read "last active Sep 1" while
 *  working all day. Every authenticated request now touches
 *  it, throttled to once per user per 5 minutes in-process and written
 *  fire-and-forget so auth never waits on it. Masquerade requests never
 *  touch the TARGET (the admin is the one active); API-key requests track
 *  last_used_at on the key instead. */
const LAST_ACCESS_TOUCH_MS = 5 * 60_000
const lastAccessTouched = new Map<string, number>()
function touchLastAccess(userId: string) {
  const now = Date.now()
  const prev = lastAccessTouched.get(userId) ?? 0
  if (now - prev < LAST_ACCESS_TOUCH_MS) return
  lastAccessTouched.set(userId, now)
  if (lastAccessTouched.size > 5000) lastAccessTouched.clear()
  void db('nivaro_users')
    .where({ id: userId })
    .update({ last_access: new Date(now) })
    .catch(() => undefined)
}

async function hydrateRole(req: FastifyRequest, user: User, opts?: { touch?: boolean }) {
  req.user = user
  setTraceUser(String(user.id))
  if (opts?.touch !== false) touchLastAccess(String(user.id))
  if (user.role) {
    const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
    req.userRole = role ?? null
    req.isAdmin = role?.admin_access ?? false
  } else {
    req.userRole = null
    req.isAdmin = false
  }
}

// ─── IPv4 CIDR matching ───────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

/** IPv4 CIDR match. A bare IP (no slash) is treated as /32. */
export function cidrMatch(ip: string, cidr: string): boolean {
  // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) as produced by Node sockets
  const cleanIp = ip.replace(/^::ffff:/i, '')
  const [range, bitsStr] = cidr.trim().split('/')
  const bits = bitsStr === undefined ? 32 : Number(bitsStr)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const ipInt = ipv4ToInt(cleanIp)
  const rangeInt = ipv4ToInt(range)
  if (ipInt === null || rangeInt === null) return false
  if (bits === 0) return true

  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) >>> 0 === (rangeInt & mask) >>> 0
}

// ─── API key (nvk_*) authentication ───────────────────────────────────────────

interface ApiKeyRow {
  id: string | number
  name: string
  key_hash: string
  prefix: string
  user: string
  scopes: string | null
  scope_restrictions: string | null
  expires_at: Date | string | null
  rate_limit_per_minute: number | null
  ip_allowlist: string | null
  last_used_at: Date | string | null
  is_active: boolean
  sandbox?: boolean | number
  graphql_max_depth?: number | null
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

const LAST_USED_THROTTLE_MS = 60_000

async function authenticateApiKey(req: FastifyRequest, reply: FastifyReply, token: string) {
  // Stamped before the lookup: a refused key is still an API-key attempt in
  // the request log, even when no key row matches it.
  req.authMethod = 'api_key'
  const hash = createHash('sha256').update(token).digest('hex')
  const key = (await db<ApiKeyRow>('nivaro_api_keys').where({ key_hash: hash }).first()) as
    | ApiKeyRow
    | undefined
  if (!key) throw httpError(401, 'Invalid API key', 'API_KEY_INVALID')
  // From here the failure belongs to a known key — the request log names it.
  req.apiKeyId = Number(key.id)
  await applyApiKey(req, reply, key, false)
}

/**
 * An admin running a request AS a key (#625): the key's own identity, scopes,
 * row restrictions, depth cap and sandbox flag bind the request exactly as
 * they bind the key's holder — so the playground shows the errors that
 * holder sees. Not counted against the key: no IP check (the admin's
 * browser is not the partner's host), no rate-limit tick, no last-used
 * stamp, no attribution in the request log.
 */
async function authenticateSimulatedKey(req: FastifyRequest, reply: FastifyReply, token: string) {
  req.authMethod = 'key_sim'
  const raw = await req.server.redis.get(`keysim:${token}`)
  if (!raw) throw httpError(401, 'The run-as-key session expired', 'KEY_SIM_EXPIRED')
  let payload: { key_id?: string | number; admin_id?: string }
  try {
    payload = JSON.parse(raw) as { key_id?: string | number; admin_id?: string }
  } catch {
    throw httpError(401, 'The run-as-key session expired', 'KEY_SIM_EXPIRED')
  }
  const key = (await db<ApiKeyRow>('nivaro_api_keys').where({ id: payload.key_id }).first()) as
    | ApiKeyRow
    | undefined
  if (!key) throw httpError(401, 'That API key no longer exists', 'API_KEY_INVALID')
  req.apiKeySimulatedId = Number(key.id)
  req.masqueradeAdminId = payload.admin_id
  await applyApiKey(req, reply, key, true)
}

async function applyApiKey(
  req: FastifyRequest,
  reply: FastifyReply,
  key: ApiKeyRow,
  simulated: boolean
) {
  if (!(key.is_active === true || (key.is_active as unknown) === 1)) {
    throw httpError(401, 'This API key has been switched off', 'API_KEY_REVOKED')
  }

  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    throw httpError(
      401,
      `This API key expired on ${new Date(key.expires_at).toISOString().slice(0, 10)}`,
      'API_KEY_EXPIRED'
    )
  }

  const allowlist = simulated ? [] : parseJsonArray<string>(key.ip_allowlist)
  if (allowlist.length > 0) {
    const ip = req.ip ?? ''
    if (!allowlist.some((cidr) => cidrMatch(ip, cidr))) {
      throw httpError(
        403,
        `This API key may not be used from ${ip || 'this address'}`,
        'API_KEY_IP_NOT_ALLOWED'
      )
    }
  }

  const limit = Number(key.rate_limit_per_minute)
  if (!simulated && Number.isFinite(limit) && limit > 0)
    await enforceKeyRateLimit(req, reply, key.id, limit)

  const user = await db<User>('nivaro_users').where({ id: key.user, status: 'active' }).first()
  if (!user)
    throw httpError(401, 'The account behind this API key is not active', 'API_KEY_OWNER_INACTIVE')

  await hydrateRole(req, user, { touch: false })
  // Key-level row scoping: rides the user object so getUserScopeEnforcement
  // (which never sees the request) can merge it with the owner's own scopes.
  const restrictions = parseJsonArray<{ dimension: string; values: Array<string | number> }>(
    key.scope_restrictions
  ).filter((r) => r && typeof r.dimension === 'string' && Array.isArray(r.values))
  if (restrictions.length > 0) user.api_key_scope_restrictions = restrictions
  // Sandbox keys (#166): writes simulate instead of persisting.
  if (key.sandbox === true || key.sandbox === 1) {
    user.api_key_sandbox = true
    // The items API and GraphQL rehearse a sandbox key's writes. Every other
    // route would store them, so a sandbox key may only read there.
    const path = (req.url ?? '').split('?')[0]
    const rehearsed = /^\/api\/items(\/|$)/.test(path) || /^(\/api)?\/graphql\/?$/.test(path)
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !rehearsed) {
      throw httpError(
        403,
        'A sandbox key stores nothing. It can read everywhere and rehearse writes through the items API and GraphQL.',
        'SANDBOX_KEY_READ_ONLY'
      )
    }
  }
  // Per-key GraphQL cost cap (#162).
  if (key.graphql_max_depth != null) user.api_key_graphql_max_depth = Number(key.graphql_max_depth)
  req.apiKeyScopes = parseJsonArray<ApiKeyScope>(key.scopes)
  // Scopes narrower than everything ride the user object, where can() reads
  // them: every permission-checked read and write is held to them.
  if (!scopesAreOpen(req.apiKeyScopes)) user.api_key_scopes = req.apiKeyScopes
  req.apiKeyRateLimit = key.rate_limit_per_minute ?? null
  if (simulated) return
  req.apiKeyId = Number(key.id)

  // Update last_used_at, throttled to once per 60s to avoid write amplification
  const lastUsed = key.last_used_at ? new Date(key.last_used_at).getTime() : 0
  if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
    db('nivaro_api_keys')
      .where({ id: key.id })
      .update({ last_used_at: new Date() })
      .catch(() => {
        /* non-fatal */
      })
  }
}

/**
 * Scope check for API-key-authenticated requests.
 * Returns true for session / static-token auth (no apiKeyScopes on the request).
 * Route handlers can adopt this incrementally.
 */
export function checkApiKeyScope(req: FastifyRequest, action: string, collection: string): boolean {
  const scopes = req.apiKeyScopes
  if (!scopes) return true
  return scopeAllows(scopes, action, collection)
}

// ─── Main authenticate middleware ─────────────────────────────────────────────

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  // Timed as its own phase (Traffic Map latency split, #1151); a pass-through outside a request.
  return span('auth', () => authenticateRequest(req, reply))
}

async function authenticateRequest(req: FastifyRequest, reply: FastifyReply) {
  await authenticateIdentity(req, reply)
  // Traffic Map circuit breaker (#1157): a caller an admin paused or limited during an incident.
  // No breaker set = a size check; the verdict is kept on the request (authenticate can run twice).
  try {
    await callerBreakerCheck(req)
  } catch (err) {
    const retry = (err as { retryAfter?: number }).retryAfter
    if (retry) void reply.header('Retry-After', String(retry))
    throw err
  }
}

async function authenticateIdentity(req: FastifyRequest, reply: FastifyReply) {
  // Bearer auth — Authorization: Bearer <token>
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token) {
      // Named API key
      if (token.startsWith('nvk_')) {
        await authenticateApiKey(req, reply, token)
        req.authMethod = 'api_key'
        return
      }
      // Run-as-key token — admin-issued, Redis-backed, resolves to the key's identity
      if (token.startsWith('nvq_')) {
        await authenticateSimulatedKey(req, reply, token)
        return
      }
      // Masquerade token — admin-issued, Redis-backed, resolves to the target user
      if (token.startsWith('nvm_')) {
        req.authMethod = 'masquerade'
        const raw = await req.server.redis.get(`masq:${token}`)
        if (!raw) throw httpError(401, 'Masquerade session expired', 'MASQUERADE_EXPIRED')
        let payload: { user_id?: string; admin_id?: string }
        try {
          payload = JSON.parse(raw) as { user_id?: string; admin_id?: string }
        } catch {
          throw httpError(401, 'Masquerade session expired', 'MASQUERADE_EXPIRED')
        }
        const user = await db<User>('nivaro_users')
          .where({ id: payload.user_id, status: 'active' })
          .first()
        if (!user)
          throw httpError(401, 'Masqueraded user is not active', 'MASQUERADE_TARGET_INACTIVE')
        await hydrateRole(req, user, { touch: false })
        req.masqueradeAdminId = payload.admin_id
        req.authMethod = 'masquerade'
        touchMasqueradeMarker(req.server.redis, String(user.id), payload.admin_id)
        return
      }
      // Static user token
      const user = await db<User>('nivaro_users').where({ static_token: token }).first()
      if (user && user.status === 'active') {
        await hydrateRole(req, user)
        req.authMethod = 'token'
        return
      }
      if (user) {
        // The token is real; the account behind it cannot act.
        req.authMethod = 'token'
        throw httpError(401, 'The account behind this token is not active', 'ACCOUNT_NOT_ACTIVE')
      }
    }
    // Token provided but not valid — don't fall through to session
    req.authMethod = 'token'
    throw httpError(401, 'Invalid token', 'TOKEN_INVALID')
  }

  // Session auth
  const userId = req.session.userId
  if (!userId) throw httpError(401, 'Unauthorized', 'NOT_SIGNED_IN')

  const user = await db<User>('nivaro_users').where({ id: userId, status: 'active' }).first()
  if (!user) {
    await req.session.destroy()
    throw httpError(401, 'Unauthorized', 'ACCOUNT_NOT_ACTIVE')
  }

  // Session policy (#665): max age + idle timeout, per role. Only sessions are
  // judged — tokens and API keys carry their own expiry.
  const { getSessionPolicy, limitsFor, judgeSession } = await import(
    '../services/session-policy.js'
  )
  const policy = await getSessionPolicy()
  const now = Date.now()
  if (policy) {
    const verdict = judgeSession(
      limitsFor(policy, user.role as string | null),
      { loginAt: req.session.loginAt, lastSeenAt: req.session.lastSeenAt },
      now
    )
    if (!verdict.ok) {
      await req.session.destroy()
      req.authMethod = 'session'
      throw httpError(
        401,
        verdict.reason === 'idle'
          ? 'Your session ended after a period of inactivity. Sign in again.'
          : 'Your session reached its time limit. Sign in again.',
        'SESSION_EXPIRED'
      )
    }
  }
  if (!req.session.loginAt) req.session.loginAt = now
  req.session.lastSeenAt = now

  await hydrateRole(req, user)
  req.authMethod = 'session'
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply)
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply)
  if (!req.isAdmin) throw httpError(403, 'Forbidden', 'ADMIN_ONLY')
  // A key limited to named collections stays out of administration, whoever
  // owns it.
  if (req.user?.api_key_scopes)
    throw httpError(
      403,
      'This API key is limited to named collections and cannot use administrator routes',
      'API_KEY_SCOPE_MISSING'
    )
}

/**
 * Many routes answer a refused permission with a bare `Forbidden`. When the
 * refusal came from the key's own scopes, the caller is told which scope.
 */
export function scopeRefusalBody(
  req: FastifyRequest,
  status: number,
  payload: unknown
): string | null {
  if (status !== 403) return null
  const denied = req.user?.api_key_scope_denied
  if (!denied || typeof payload !== 'string') return null
  try {
    const body = JSON.parse(payload) as Record<string, unknown>
    if (typeof body.code === 'string' && body.code !== 'FORBIDDEN') return null
    return JSON.stringify({
      statusCode: 403,
      error: 'Forbidden',
      message: `This API key has no ${denied.action} scope on ${denied.collection}`,
      code: 'API_KEY_SCOPE_MISSING',
      scope: denied
    })
  } catch {
    return null
  }
}
