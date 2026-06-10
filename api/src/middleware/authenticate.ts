import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
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
  }
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode })
}

async function hydrateRole(req: FastifyRequest, user: User) {
  req.user = user
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
  expires_at: Date | string | null
  rate_limit_per_minute: number | null
  ip_allowlist: string | null
  last_used_at: Date | string | null
  is_active: boolean
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

async function authenticateApiKey(req: FastifyRequest, token: string) {
  const hash = createHash('sha256').update(token).digest('hex')
  const key = (await db<ApiKeyRow>('nivaro_api_keys')
    .where({ key_hash: hash, is_active: true })
    .first()) as ApiKeyRow | undefined
  if (!key) throw httpError(401, 'Invalid API key')

  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    throw httpError(401, 'API key expired')
  }

  const allowlist = parseJsonArray<string>(key.ip_allowlist)
  if (allowlist.length > 0) {
    const ip = req.ip ?? ''
    if (!allowlist.some((cidr) => cidrMatch(ip, cidr))) {
      throw httpError(403, 'IP address not allowed for this API key')
    }
  }

  const user = await db<User>('nivaro_users').where({ id: key.user, status: 'active' }).first()
  if (!user) throw httpError(401, 'API key owner is not active')

  await hydrateRole(req, user)
  req.apiKeyScopes = parseJsonArray<ApiKeyScope>(key.scopes)
  req.apiKeyRateLimit = key.rate_limit_per_minute ?? null

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
  return scopes.some(
    (s) =>
      (s.collection === '*' || s.collection === collection) &&
      Array.isArray(s.actions) &&
      (s.actions.includes('*') || s.actions.includes(action))
  )
}

// ─── Main authenticate middleware ─────────────────────────────────────────────

export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  // Bearer auth — Authorization: Bearer <token>
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (token) {
      // Named API key
      if (token.startsWith('nvk_')) {
        await authenticateApiKey(req, token)
        return
      }
      // Static user token
      const user = await db<User>('nivaro_users')
        .where({ static_token: token, status: 'active' })
        .first()
      if (user) {
        await hydrateRole(req, user)
        return
      }
    }
    // Token provided but not valid — don't fall through to session
    throw httpError(401, 'Invalid token')
  }

  // Session auth
  const userId = req.session.userId
  if (!userId) throw httpError(401, 'Unauthorized')

  const user = await db<User>('nivaro_users').where({ id: userId, status: 'active' }).first()
  if (!user) {
    await req.session.destroy()
    throw httpError(401, 'Unauthorized')
  }

  await hydrateRole(req, user)
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply)
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await authenticate(req, reply)
  if (!req.isAdmin) throw httpError(403, 'Forbidden')
}
