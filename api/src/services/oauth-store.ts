import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { ACCESS_PREFIX, hashToken, OAUTH_SCOPE, REFRESH_PREFIX, randomToken } from '../lib/oauth.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Redis-backed OAuth state for remote MCP clients — no table, no migration.
 *
 *   client:<id>      a dynamically registered client (RFC 7591); 180 days, renewed on use
 *   code:<hash>      an authorization code; 2 minutes, deleted on first use
 *   grant:<id>       one person's consent to one client — the connection they can revoke
 *   at:<hash>        an access token (1 hour) naming its grant
 *   rt:<hash>        a refresh token (30 days, rotated on every use) naming its grant
 *   user:<uid>       the person's grant ids (the "connected apps" list)
 *
 * Tokens and codes are stored by hash only. Every token is checked against its
 * grant, so revoking a connection ends its tokens at once. Cloud: every record
 * carries the tenant it was made in and is refused on another tenant's host.
 */

const P = 'nvr:oauth:'
export const ACCESS_TTL_S = 3600
export const REFRESH_TTL_S = 30 * 86_400
const CODE_TTL_S = 120
const CLIENT_TTL_S = 180 * 86_400

export interface OAuthClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
  created_at: string
  t: string
}

export interface OAuthGrant {
  id: string
  user_id: string
  client_id: string
  client_name: string
  scope: string
  created_at: string
  last_used_at: string | null
  t: string
}

interface CodeRecord {
  client_id: string
  user_id: string
  grant_id: string
  redirect_uri: string
  code_challenge: string
  resource: string | null
  t: string
}

interface TokenRecord {
  grant_id: string
  user_id: string
  client_id: string
  resource: string | null
  t: string
}

const read = async <T>(redis: Redis, key: string): Promise<T | null> => {
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
const sameTenant = (rec: { t?: string } | null) => !!rec && rec.t === currentTenantKey()

export async function registerClient(
  redis: Redis,
  input: { client_name: string; redirect_uris: string[] }
): Promise<OAuthClient> {
  const client: OAuthClient = {
    client_id: `nvc_${randomUUID()}`,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    created_at: new Date().toISOString(),
    t: currentTenantKey()
  }
  await redis.setex(`${P}client:${client.client_id}`, CLIENT_TTL_S, JSON.stringify(client))
  return client
}

export async function getClient(redis: Redis, clientId: string): Promise<OAuthClient | null> {
  if (!/^nvc_[0-9a-f-]{36}$/.test(clientId)) return null
  const c = await read<OAuthClient>(redis, `${P}client:${clientId}`)
  if (!sameTenant(c)) return null
  await redis.expire(`${P}client:${clientId}`, CLIENT_TTL_S)
  return c
}

/** The person's grant for this client (reused on a second consent), else a new one. */
export async function upsertGrant(
  redis: Redis,
  userId: string,
  client: OAuthClient
): Promise<OAuthGrant> {
  const ids = await redis.smembers(`${P}user:${userId}`)
  for (const id of ids) {
    const g = await read<OAuthGrant>(redis, `${P}grant:${id}`)
    if (g && g.client_id === client.client_id && sameTenant(g)) return g
  }
  const grant: OAuthGrant = {
    id: randomUUID(),
    user_id: userId,
    client_id: client.client_id,
    client_name: client.client_name,
    scope: OAUTH_SCOPE,
    created_at: new Date().toISOString(),
    last_used_at: null,
    t: currentTenantKey()
  }
  await redis
    .multi()
    .set(`${P}grant:${grant.id}`, JSON.stringify(grant))
    .sadd(`${P}user:${userId}`, grant.id)
    .exec()
  return grant
}

export async function issueCode(redis: Redis, rec: Omit<CodeRecord, 't'>): Promise<string> {
  const code = randomToken()
  await redis.setex(
    `${P}code:${hashToken(code)}`,
    CODE_TTL_S,
    JSON.stringify({ ...rec, t: currentTenantKey() })
  )
  return code
}

/** The code's record, deleted as it is read — a code works once. */
export async function consumeCode(redis: Redis, code: string): Promise<CodeRecord | null> {
  const key = `${P}code:${hashToken(code)}`
  const raw = await redis.getdel(key)
  if (!raw) return null
  try {
    const rec = JSON.parse(raw) as CodeRecord
    return sameTenant(rec) ? rec : null
  } catch {
    return null
  }
}

export interface IssuedTokens {
  access_token: string
  refresh_token: string
  expires_in: number
}

export async function issueTokens(
  redis: Redis,
  rec: Omit<TokenRecord, 't'>
): Promise<IssuedTokens> {
  const access = randomToken(ACCESS_PREFIX)
  const refresh = randomToken(REFRESH_PREFIX)
  const value = JSON.stringify({ ...rec, t: currentTenantKey() })
  await redis
    .multi()
    .setex(`${P}at:${hashToken(access)}`, ACCESS_TTL_S, value)
    .setex(`${P}rt:${hashToken(refresh)}`, REFRESH_TTL_S, value)
    .exec()
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_S }
}

/** Rotate: the refresh token is spent; the caller issues a new pair. */
export async function consumeRefresh(redis: Redis, refresh: string): Promise<TokenRecord | null> {
  const raw = await redis.getdel(`${P}rt:${hashToken(refresh)}`)
  if (!raw) return null
  try {
    const rec = JSON.parse(raw) as TokenRecord
    if (!sameTenant(rec)) return null
    return (await redis.exists(`${P}grant:${rec.grant_id}`)) ? rec : null
  } catch {
    return null
  }
}

/** An access token's record while its grant stands; touches the grant's last use (≤ once a minute). */
export async function resolveAccessToken(redis: Redis, token: string): Promise<TokenRecord | null> {
  const rec = await read<TokenRecord>(redis, `${P}at:${hashToken(token)}`)
  if (!sameTenant(rec) || !rec) return null
  const grant = await read<OAuthGrant>(redis, `${P}grant:${rec.grant_id}`)
  if (!grant) return null
  const last = grant.last_used_at ? Date.parse(grant.last_used_at) : 0
  if (Date.now() - last > 60_000) {
    grant.last_used_at = new Date().toISOString()
    await redis.set(`${P}grant:${grant.id}`, JSON.stringify(grant))
  }
  return rec
}

/** Revoke one token (RFC 7009) — either kind. */
export async function revokeToken(redis: Redis, token: string): Promise<void> {
  const h = hashToken(token)
  await redis.del(`${P}at:${h}`, `${P}rt:${h}`)
}

export async function listGrants(redis: Redis, userId: string): Promise<OAuthGrant[]> {
  const ids = await redis.smembers(`${P}user:${userId}`)
  const out: OAuthGrant[] = []
  for (const id of ids) {
    const g = await read<OAuthGrant>(redis, `${P}grant:${id}`)
    if (!g) await redis.srem(`${P}user:${userId}`, id)
    else if (sameTenant(g)) out.push(g)
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** End a connection: its tokens stop working at once (each checks its grant). */
export async function revokeGrant(redis: Redis, userId: string, grantId: string): Promise<boolean> {
  const g = await read<OAuthGrant>(redis, `${P}grant:${grantId}`)
  if (!g || g.user_id !== userId || !sameTenant(g)) return false
  await redis.multi().del(`${P}grant:${grantId}`).srem(`${P}user:${userId}`, grantId).exec()
  return true
}
