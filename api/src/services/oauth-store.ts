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
 *   grant-idle:<id>  the idle review's stamps on a grant (#2497); its own key with its own TTL,
 *                    so the review never rewrites (or resurrects) a grant; deleted on revoke/use
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
/** Idle stamps outlive any review window (flag ≤ 365 days, disconnect ≤ 730) and then lapse. */
const IDLE_TTL_S = 800 * 86_400
const idleKey = (grantId: string) => `${P}grant-idle:${grantId}`

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
  /** Idle review (#2497): when the owner was told the connection is unused… */
  idle_flagged_at?: string | null
  /** …and when they were told it will be disconnected. Both clear on the next use. */
  idle_notice_at?: string | null
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

/**
 * The person's grant for this client (reused on a second consent), else a new one.
 * The grant carries the scope chosen on THIS consent: a second consent that leaves
 * chat unticked takes chat away from the connection's existing tokens too.
 */
export async function upsertGrant(
  redis: Redis,
  userId: string,
  client: OAuthClient,
  scope: string = OAUTH_SCOPE
): Promise<OAuthGrant> {
  const ids = await redis.smembers(`${P}user:${userId}`)
  for (const id of ids) {
    const g = await read<OAuthGrant>(redis, `${P}grant:${id}`)
    if (g && g.client_id === client.client_id && sameTenant(g)) {
      if (g.scope !== scope) {
        g.scope = scope
        await redis.set(`${P}grant:${g.id}`, JSON.stringify(g))
      }
      return g
    }
  }
  const grant: OAuthGrant = {
    id: randomUUID(),
    user_id: userId,
    client_id: client.client_id,
    client_name: client.client_name,
    scope,
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

/** A rotated refresh token presented again inside this window is refused but forgiven (a client
 *  retrying a refresh whose answer it lost); after it, a replay ends the whole connection. */
export const REFRESH_REUSE_GRACE_S = 30

const spentKey = (hash: string) => `${P}rt-spent:${hash}`

export type ConsumeRefreshResult =
  | { ok: true; rec: TokenRecord }
  | { ok: false; reason: 'unknown' | 'revoked' }
  /** A replayed refresh token: the grant it belonged to has been ended (who + which, for the log). */
  | { ok: false; reason: 'reused'; user_id: string; grant_id: string }

/**
 * Rotate: the refresh token is spent; the caller issues a new pair. A spent token stays
 * remembered (by hash) for its lifetime, so a REPLAY is detected (security audit M18, OAuth
 * 2.1 refresh-token reuse): a stolen token used after the real client rotated it — or the real
 * client after the thief did — revokes the grant, ending every token of that connection.
 */
export async function consumeRefreshChecked(
  redis: Redis,
  refresh: string
): Promise<ConsumeRefreshResult> {
  const h = hashToken(refresh)
  const raw = await redis.getdel(`${P}rt:${h}`)
  if (!raw) {
    const spent = await read<{ grant_id: string; user_id: string; at: number; t: string }>(
      redis,
      spentKey(h)
    )
    if (!spent || !sameTenant(spent)) return { ok: false, reason: 'unknown' }
    if (Date.now() - spent.at > REFRESH_REUSE_GRACE_S * 1000) {
      await revokeGrant(redis, spent.user_id, spent.grant_id).catch(() => false)
      return { ok: false, reason: 'reused', user_id: spent.user_id, grant_id: spent.grant_id }
    }
    return { ok: false, reason: 'unknown' }
  }
  try {
    const rec = JSON.parse(raw) as TokenRecord
    if (!sameTenant(rec)) return { ok: false, reason: 'unknown' }
    await redis.setex(
      spentKey(h),
      REFRESH_TTL_S,
      JSON.stringify({
        grant_id: rec.grant_id,
        user_id: rec.user_id,
        at: Date.now(),
        t: currentTenantKey()
      })
    )
    return (await redis.exists(`${P}grant:${rec.grant_id}`))
      ? { ok: true, rec }
      : { ok: false, reason: 'revoked' }
  } catch {
    return { ok: false, reason: 'unknown' }
  }
}

/** Rotate (the record, or null when the token cannot be used — see consumeRefreshChecked). */
export async function consumeRefresh(redis: Redis, refresh: string): Promise<TokenRecord | null> {
  const out = await consumeRefreshChecked(redis, refresh)
  return out.ok ? out.rec : null
}

/** The scope a grant carries now (the base scope for a grant stored before scopes). */
export async function grantScope(redis: Redis, grantId: string): Promise<string> {
  const grant = await read<OAuthGrant>(redis, `${P}grant:${grantId}`)
  return grant?.scope || OAUTH_SCOPE
}

/**
 * An access token's record while its grant stands, with the grant's CURRENT scope
 * and the app's registered name; touches the grant's last use (≤ once a minute),
 * which also clears any idle-review flag.
 */
export async function resolveAccessToken(
  redis: Redis,
  token: string
): Promise<(TokenRecord & { scope: string; client_name: string }) | null> {
  const rec = await read<TokenRecord>(redis, `${P}at:${hashToken(token)}`)
  if (!sameTenant(rec) || !rec) return null
  const grant = await read<OAuthGrant>(redis, `${P}grant:${rec.grant_id}`)
  if (!grant) return null
  const last = grant.last_used_at ? Date.parse(grant.last_used_at) : 0
  if (Date.now() - last > 60_000) {
    const { idle_flagged_at: _f, idle_notice_at: _n, ...stored } = grant
    stored.last_used_at = new Date().toISOString()
    // XX: never recreate a grant revoked since the read; KEEPTTL: never drop an expiry.
    // Being used clears the idle review's stamps.
    await redis
      .multi()
      .set(`${P}grant:${grant.id}`, JSON.stringify(stored), 'KEEPTTL', 'XX')
      .del(idleKey(grant.id))
      .exec()
  }
  return { ...rec, scope: grant.scope || OAUTH_SCOPE, client_name: grant.client_name }
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
  return (await withIdleStamps(redis, out)).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** End a connection: its tokens stop working at once (each checks its grant). */
export async function revokeGrant(redis: Redis, userId: string, grantId: string): Promise<boolean> {
  const g = await read<OAuthGrant>(redis, `${P}grant:${grantId}`)
  if (!g || g.user_id !== userId || !sameTenant(g)) return false
  await redis
    .multi()
    .del(`${P}grant:${grantId}`)
    .del(idleKey(grantId))
    .srem(`${P}user:${userId}`, grantId)
    .exec()
  return true
}

/** One grant by id (this tenant's), or null. */
export async function getGrant(redis: Redis, grantId: string): Promise<OAuthGrant | null> {
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) return null
  const g = await read<OAuthGrant>(redis, `${P}grant:${grantId}`)
  if (!g || !sameTenant(g)) return null
  return (await withIdleStamps(redis, [g]))[0]
}

type IdleStamps = Pick<OAuthGrant, 'idle_flagged_at' | 'idle_notice_at'>

/** Grants with their idle-review stamps (one MGET). */
async function withIdleStamps(redis: Redis, grants: OAuthGrant[]): Promise<OAuthGrant[]> {
  if (grants.length === 0) return grants
  const raws = await redis.mget(...grants.map((g) => idleKey(g.id)))
  return grants.map((g, i) => {
    const raw = raws[i]
    if (!raw) return { ...g, idle_flagged_at: null, idle_notice_at: null }
    try {
      const st = JSON.parse(raw) as IdleStamps
      return {
        ...g,
        idle_flagged_at: st.idle_flagged_at ?? null,
        idle_notice_at: st.idle_notice_at ?? null
      }
    } catch {
      return { ...g, idle_flagged_at: null, idle_notice_at: null }
    }
  })
}

/**
 * Set (or with both null, clear) the idle-review stamps of a grant that still stands. They live
 * in their own key: the grant itself is never rewritten here, so a revoke racing the review can
 * never be undone by it. A stamp written just after a revoke is removed again (and would lapse).
 */
export async function setGrantIdleStamps(
  redis: Redis,
  grantId: string,
  stamps: IdleStamps
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) return
  if (!stamps.idle_flagged_at && !stamps.idle_notice_at) {
    await redis.del(idleKey(grantId))
    return
  }
  if (!(await getGrant(redis, grantId))) return
  await redis.setex(
    idleKey(grantId),
    IDLE_TTL_S,
    JSON.stringify({
      idle_flagged_at: stamps.idle_flagged_at ?? null,
      idle_notice_at: stamps.idle_notice_at ?? null
    })
  )
  if (!(await redis.exists(`${P}grant:${grantId}`))) await redis.del(idleKey(grantId))
}

/** Every connection on this tenant, across people (admin view, idle review). SCAN, never KEYS. */
export async function listAllGrants(redis: Redis, cap = 20_000): Promise<OAuthGrant[]> {
  const out: OAuthGrant[] = []
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${P}grant:*`, 'COUNT', 500)
    cursor = next
    if (keys.length) {
      const raws = await redis.mget(...keys)
      for (const raw of raws) {
        if (!raw) continue
        try {
          const g = JSON.parse(raw) as OAuthGrant
          if (sameTenant(g)) out.push(g)
        } catch {
          // skip a damaged record
        }
      }
    }
  } while (cursor !== '0' && out.length < cap)
  const stamped: OAuthGrant[] = []
  for (let i = 0; i < out.length; i += 500)
    stamped.push(...(await withIdleStamps(redis, out.slice(i, i + 500))))
  return stamped.sort((a, b) => b.created_at.localeCompare(a.created_at))
}
