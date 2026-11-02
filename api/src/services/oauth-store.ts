import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { DevicePlatform } from '../lib/mobile-clients.js'
import {
  ACCESS_PREFIX,
  DEVICE_ACCESS_PREFIX,
  DEVICE_REFRESH_PREFIX,
  hashToken,
  OAUTH_SCOPE,
  REFRESH_PREFIX,
  randomToken
} from '../lib/oauth.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Redis-backed OAuth state for remote MCP clients and first-party phone apps — no table, no
 * migration. A grant and its tokens have a `kind`: 'mcp' (a connected app, `nvo_`/`nvor_`) or
 * 'device' (one phone signed in to a first-party app, `nvd_`/`nvdr_`). Records stored before
 * kinds existed carry none and are 'mcp' (`kindOf`).
 *
 *   client:<id>      a dynamically registered client (RFC 7591); 180 days, renewed on use
 *   code:<hash>      an authorization code; 2 minutes, deleted on first use
 *   grant:<id>       one person's consent to one client — the connection they can revoke
 *                    (a device grant: one phone's sign-in; a new grant per sign-in)
 *   at:<hash>        an access token (1 hour) naming its grant
 *   rt:<hash>        a refresh token (30 days, rotated on every use) naming its grant
 *   user:<uid>       the person's grant ids (the "connected apps" list)
 *   grant-idle:<id>  the idle review's stamps on a grant (#2497); its own key with its own TTL,
 *                    so the review never rewrites (or resurrects) a grant; deleted on revoke/use
 *   grant-push:<id>  a device grant's phone push row ids (a SET); read and deleted with the grant
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
/** A device grant's phone push rows: a SET of its own (SADD/SREM), so no read-modify-write of
 *  the grant JSON (the last-use stamp rewrites it) can drop one. Touched only after the grant
 *  itself was read for this tenant, like grant-idle. */
const pushKey = (grantId: string) => `${P}grant-push:${grantId}`

export type TokenKind = 'mcp' | 'device'

/** The phone a device grant / token belongs to (both optional — the app may not say). */
export interface DeviceInfo {
  device_name?: string
  platform?: DevicePlatform
}

/** A record's kind; a record stored before kinds existed is 'mcp'. */
export const kindOf = (rec: { kind?: TokenKind } | null | undefined): TokenKind =>
  rec?.kind === 'device' ? 'device' : 'mcp'

export interface OAuthClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
  created_at: string
  t: string
}

export interface OAuthGrant extends DeviceInfo {
  id: string
  user_id: string
  client_id: string
  client_name: string
  scope: string
  kind: TokenKind
  /** Device grants: the phone push rows (nivaro_push_subscriptions ids) this sign-in made —
   *  only on what `takeGrant` hands back (they live in grant-push:<id>, never in the grant). */
  push_ids?: number[]
  created_at: string
  last_used_at: string | null
  t: string
  /** Idle review (#2497): when the owner was told the connection is unused… */
  idle_flagged_at?: string | null
  /** …and when they were told it will be disconnected. Both clear on the next use. */
  idle_notice_at?: string | null
}

interface CodeRecord extends DeviceInfo {
  kind: TokenKind
  client_id: string
  /** Device codes: the app's name, for the grant made when the code is exchanged. */
  client_name?: string
  user_id: string
  /** MCP codes: the grant consented to. Device codes: '' — their grant is made on exchange. */
  grant_id: string
  redirect_uri: string
  code_challenge: string
  resource: string | null
  /** Device codes: the issuer the authorize answer named (the origin the sign-in arrived on);
   *  the code is exchanged only on that origin. */
  iss?: string
  t: string
}

export interface TokenRecord extends DeviceInfo {
  grant_id: string
  user_id: string
  client_id: string
  resource: string | null
  kind: TokenKind
  push_ids?: number[]
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
  client: Pick<OAuthClient, 'client_id' | 'client_name'>,
  scope: string = OAUTH_SCOPE
): Promise<OAuthGrant> {
  const ids = await redis.smembers(`${P}user:${userId}`)
  for (const id of ids) {
    const g = await read<OAuthGrant>(redis, `${P}grant:${id}`)
    if (g && g.client_id === client.client_id && kindOf(g) === 'mcp' && sameTenant(g)) {
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
    kind: 'mcp',
    created_at: new Date().toISOString(),
    last_used_at: null,
    t: currentTenantKey()
  }
  await storeGrant(redis, grant)
  return grant
}

/**
 * One phone's sign-in to a first-party app: always a NEW grant (never reused), so each phone is
 * its own connection — listed, aged and revoked on its own.
 */
export async function createDeviceGrant(
  redis: Redis,
  userId: string,
  client: { client_id: string; client_name: string },
  device: DeviceInfo
): Promise<OAuthGrant> {
  const grant: OAuthGrant = {
    id: randomUUID(),
    user_id: userId,
    client_id: client.client_id,
    client_name: client.client_name,
    scope: OAUTH_SCOPE,
    kind: 'device',
    device_name: device.device_name,
    platform: device.platform,
    created_at: new Date().toISOString(),
    last_used_at: null,
    t: currentTenantKey()
  }
  await storeGrant(redis, grant)
  return grant
}

async function storeGrant(redis: Redis, grant: OAuthGrant): Promise<void> {
  await redis
    .multi()
    .set(`${P}grant:${grant.id}`, JSON.stringify(grant))
    .sadd(`${P}user:${grant.user_id}`, grant.id)
    .exec()
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

/**
 * A new access + refresh pair for a grant. `kind` picks the prefixes ('device' = `nvd_`/`nvdr_`)
 * and is stored on both records, so a refresh keeps the kind and a token is only ever resolved
 * as the kind it was issued as.
 */
export async function issueTokens(
  redis: Redis,
  rec: Omit<TokenRecord, 't' | 'kind'> & Partial<Pick<TokenRecord, 't' | 'kind'>>,
  kind: TokenKind = 'mcp'
): Promise<IssuedTokens> {
  const device = kind === 'device'
  const access = randomToken(device ? DEVICE_ACCESS_PREFIX : ACCESS_PREFIX)
  const refresh = randomToken(device ? DEVICE_REFRESH_PREFIX : REFRESH_PREFIX)
  // A rotated record's own tenant stamp and kind are replaced: `kind` and this tenant decide.
  const { t: _t, kind: _k, ...fields } = rec
  const value = JSON.stringify({ ...fields, kind, t: currentTenantKey() })
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
  /** A replayed refresh token: the grant it belonged to has been ended (who + which, for the log;
   *  `grant` = what was stored, so a phone's push rows can go too). */
  | { ok: false; reason: 'reused'; user_id: string; grant_id: string; grant: OAuthGrant | null }

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
      const grant = await takeGrant(redis, spent.user_id, spent.grant_id).catch(() => null)
      return {
        ok: false,
        reason: 'reused',
        user_id: spent.user_id,
        grant_id: spent.grant_id,
        grant
      }
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
      ? { ok: true, rec: { ...rec, kind: kindOf(rec) } }
      : { ok: false, reason: 'revoked' }
  } catch {
    return { ok: false, reason: 'unknown' }
  }
}

/**
 * The record behind a refresh token WITHOUT spending it (this tenant's, or null) — so the token
 * endpoint can read the account first, and a database error leaves the token usable.
 */
export async function peekRefresh(redis: Redis, refresh: string): Promise<TokenRecord | null> {
  if (!refresh) return null
  const rec = await read<TokenRecord>(redis, `${P}rt:${hashToken(refresh)}`)
  return rec && sameTenant(rec) ? { ...rec, kind: kindOf(rec) } : null
}

/** A device access token's record WITHOUT using it (no last-use touch), this tenant's, or null. */
export async function peekDeviceAccess(redis: Redis, token: string): Promise<TokenRecord | null> {
  if (!token.startsWith(DEVICE_ACCESS_PREFIX)) return null
  const rec = await read<TokenRecord>(redis, `${P}at:${hashToken(token)}`)
  return rec && sameTenant(rec) && kindOf(rec) === 'device' ? { ...rec, kind: 'device' } : null
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
 * which also clears any idle-review flag. Only a token of `kind` resolves (with that
 * kind's prefix): a device token is never an MCP token, nor the other way round.
 * `grant_created_at` / `grant_last_used_at` are the grant's stamps as read BEFORE this
 * use touched them (a phone's sign-in is judged by the session policy on them).
 */
export async function resolveAccessToken(
  redis: Redis,
  token: string,
  kind: TokenKind = 'mcp'
): Promise<
  | (TokenRecord & {
      scope: string
      client_name: string
      grant_created_at: string
      grant_last_used_at: string | null
    })
  | null
> {
  if (!token.startsWith(kind === 'device' ? DEVICE_ACCESS_PREFIX : ACCESS_PREFIX)) return null
  const rec = await read<TokenRecord>(redis, `${P}at:${hashToken(token)}`)
  if (!sameTenant(rec) || !rec || kindOf(rec) !== kind) return null
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
  return {
    ...rec,
    kind: kindOf(rec),
    scope: grant.scope || OAUTH_SCOPE,
    client_name: grant.client_name,
    grant_created_at: grant.created_at,
    grant_last_used_at: grant.last_used_at
  }
}

/** Revoke one token (RFC 7009) — either kind. */
export async function revokeToken(redis: Redis, token: string): Promise<void> {
  const h = hashToken(token)
  await redis.del(`${P}at:${h}`, `${P}rt:${h}`)
}

/**
 * The person's grants (newest first). `kind` keeps one kind: 'mcp' = connected apps (what every
 * MCP list, review and notice means — never a phone), 'device' = signed-in phones.
 */
export async function listGrants(
  redis: Redis,
  userId: string,
  kind?: TokenKind
): Promise<OAuthGrant[]> {
  const ids = await redis.smembers(`${P}user:${userId}`)
  const out: OAuthGrant[] = []
  for (const id of ids) {
    const g = await read<OAuthGrant>(redis, `${P}grant:${id}`)
    if (!g) await redis.srem(`${P}user:${userId}`, id)
    else if (sameTenant(g) && (!kind || kindOf(g) === kind)) out.push(g)
  }
  return (await withIdleStamps(redis, out)).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

const sameUser = (a: string, b: string) => String(a).toUpperCase() === String(b).toUpperCase()

/**
 * End a grant of this person (any id case) and hand back what was stored, or null when there is
 * none of `kind` here. Its tokens stop working at once (each checks its grant).
 */
export async function takeGrant(
  redis: Redis,
  userId: string,
  grantId: string,
  kind?: TokenKind
): Promise<OAuthGrant | null> {
  const g = await read<OAuthGrant>(redis, `${P}grant:${grantId}`)
  if (!g || !sameUser(g.user_id, userId) || !sameTenant(g)) return null
  const k = kindOf(g)
  if (kind && k !== kind) return null
  const tx = redis.multi()
  // A device grant's push ids are read and deleted in the same transaction as the grant: an
  // SADD lands either before (and is returned) or after (and addGrantPushId sees no grant).
  if (k === 'device') tx.smembers(pushKey(grantId)).del(pushKey(grantId))
  const res = await tx
    .del(`${P}grant:${grantId}`)
    .del(idleKey(grantId))
    .srem(`${P}user:${g.user_id}`, grantId)
    .exec()
  if (k !== 'device') return { ...g, kind: k }
  const members = execValue<string[]>(res?.[0]) ?? []
  const ids = [...(g.push_ids ?? []), ...members.map(Number)].filter(
    (n) => Number.isInteger(n) && n > 0
  )
  return { ...g, kind: k, push_ids: [...new Set(ids)] }
}

/** One MULTI reply: ioredis answers `[err, value]` per command. */
function execValue<T>(entry: unknown): T | undefined {
  if (
    Array.isArray(entry) &&
    entry.length === 2 &&
    (entry[0] === null || entry[0] instanceof Error)
  )
    return entry[0] ? undefined : (entry[1] as T)
  return entry as T
}

/** End a connection: its tokens stop working at once (each checks its grant). */
export async function revokeGrant(
  redis: Redis,
  userId: string,
  grantId: string,
  kind?: TokenKind
): Promise<boolean> {
  return !!(await takeGrant(redis, userId, grantId, kind))
}

/** The push row ids a device grant holds now (its grant-push set). */
export async function grantPushIds(redis: Redis, grantId: string): Promise<number[]> {
  return (await redis.smembers(pushKey(grantId))).map(Number).filter((n) => Number.isInteger(n))
}

/**
 * Note a phone push row (nivaro_push_subscriptions id) on the device grant that registered it,
 * so ending that sign-in stops the phone's alerts too. One install's row belongs to ONE sign-in:
 * it is taken off the person's other grants (a stale sign-in on the same phone must not delete
 * the row the live one uses). Answers false when the grant was ended meanwhile — the caller
 * then deletes the row itself, as ending the grant would have. A non-device grant: true, no-op.
 */
export async function addGrantPushId(
  redis: Redis,
  grantId: string,
  pushId: number
): Promise<boolean> {
  if (!Number.isInteger(pushId) || pushId <= 0) return true
  const g = await read<OAuthGrant>(redis, `${P}grant:${grantId}`)
  if (!g || !sameTenant(g)) return false
  if (kindOf(g) !== 'device') return true
  // Known race: two sign-ins on one install registering at the same moment can both keep the
  // id (each SREMs before the other's SADD). The next registration from the live one repairs
  // it, and a stale grant's later end deletes only by id + person.
  const others = (await redis.smembers(`${P}user:${g.user_id}`)).filter((id) => id !== grantId)
  const tx = redis.multi()
  for (const id of others) tx.srem(pushKey(id), String(pushId))
  await tx.sadd(pushKey(grantId), String(pushId)).exec()
  if (await redis.exists(`${P}grant:${grantId}`)) return true
  // Ended between the read and the SADD: nothing will ever read this set again.
  await redis.del(pushKey(grantId))
  return false
}

/** The Redis key a grant is stored under (a socket bound to a phone reads it on every sweep). */
export const grantKey = (grantId: string) => `${P}grant:${grantId}`

/** One grant by id (this tenant's, of `kind` when given), or null. */
export async function getGrant(
  redis: Redis,
  grantId: string,
  kind?: TokenKind
): Promise<OAuthGrant | null> {
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) return null
  const g = await read<OAuthGrant>(redis, `${P}grant:${grantId}`)
  if (!g || !sameTenant(g)) return null
  if (kind && kindOf(g) !== kind) return null
  return (await withIdleStamps(redis, [g]))[0]
}

type IdleStamps = Pick<OAuthGrant, 'idle_flagged_at' | 'idle_notice_at'>

/** Grants with their idle-review stamps (one MGET), each with its kind (old grants: 'mcp'). */
async function withIdleStamps(redis: Redis, stored: OAuthGrant[]): Promise<OAuthGrant[]> {
  if (stored.length === 0) return stored
  const grants = stored.map((g) => ({ ...g, kind: kindOf(g) }))
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

/**
 * Every grant on this tenant, across people (admin view, idle review), of `kind` when given.
 * SCAN, never KEYS.
 */
export async function listAllGrants(
  redis: Redis,
  cap = 20_000,
  kind?: TokenKind
): Promise<OAuthGrant[]> {
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
          if (sameTenant(g) && (!kind || kindOf(g) === kind)) out.push(g)
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
