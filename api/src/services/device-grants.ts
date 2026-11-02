import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { REVOKED_PREFIX } from '../auth/session.js'
import { db } from '../db/index.js'
import { mobileSignInEnabled } from '../lib/mobile-clients.js'
import { logActivity } from './activity.js'
import { appNowForAuth } from './chaos/clock.js'
import {
  deviceRefreshLive,
  getGrant,
  grantKey,
  grantPushIds,
  listAllGrants,
  listGrants,
  type OAuthGrant,
  takeGrant
} from './oauth-store.js'
import { wherePhoneEndpoint } from './push-relay.js'
import { getSessionPolicy, judgeDeviceGrant, limitsFor } from './session-policy.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Signed-in phones: one device grant per phone sign-in (services/oauth-store.ts, kind 'device').
 * Ending one is always `endDeviceGrant` — the grant goes (so its access and refresh tokens stop
 * at once) AND the phone push rows that sign-in registered (`push_ids`), so a phone that is
 * signed out stops getting alerts too. Never a bare `revokeGrant` on a device grant.
 */

export type DeviceEndReason =
  /** The person removed it from Signed-in phones. */
  | 'removed'
  /** An administrator removed it from the person's page. */
  | 'removed-by-admin'
  /** The app signed out (POST /oauth/revoke). */
  | 'signed-out'
  /** Sign out everywhere (/logout-all, an admin's sign-out, sign out everywhere else). */
  | 'signed-out-everywhere'
  /** The role's session policy ended the sign-in (max age / idle). */
  | 'expired'
  /** Sign-in is turned off for the person's role. */
  | 'sign-in-off'
  /** A spent refresh token came back (the grant is already ended by then). */
  | 'refresh-reused'

const REASON_TEXT: Record<DeviceEndReason, string> = {
  removed: 'removed by its owner',
  'removed-by-admin': 'removed by an administrator',
  'signed-out': 'signed out on the phone',
  'signed-out-everywhere': 'signed out everywhere',
  expired: 'sign-in expired',
  'sign-in-off': 'sign-in turned off for the role',
  'refresh-reused': 'refresh token replayed'
}

/** "Nivaro on Pat's iPhone" — how a phone is named in the activity log. */
export const deviceLabel = (g: Pick<OAuthGrant, 'client_name' | 'device_name'>) =>
  `${g.client_name} on ${g.device_name || 'an unnamed device'}`

/**
 * Delete the phone push rows a device grant registered — only rows still that person's (a shared
 * phone that another person signed in on since is theirs now) and only phone rows.
 */
export async function deleteGrantPushRows(
  grant: Pick<OAuthGrant, 'user_id' | 'push_ids'> | null | undefined
): Promise<number> {
  const ids = (grant?.push_ids ?? []).filter((n) => Number.isInteger(n) && n > 0)
  if (!grant || ids.length === 0) return 0
  return Number(
    await wherePhoneEndpoint(
      db('nivaro_push_subscriptions').whereIn('id', ids).where({ user: grant.user_id })
    ).del()
  )
}

/**
 * The credential a phone push row was registered with: `grant:<id>` (a phone's sign-in) or
 * `sid:<id>` (a session). Null = something else (a key, a token) — never a reason to keep a row.
 */
export type PushCredential =
  | `grant:${string}`
  | `sid:${string}`
  /** A static user token: the first 16 hex of its SHA-256 (never the token). */
  | `token:${string}`
  /** An API key (nivaro_api_keys.id). */
  | `key:${string}`

const CREDENTIAL_RE = /^(grant|sid|token|key):./

/** A static token's stamp: `token:` + the first 16 hex characters of its SHA-256. */
export function staticTokenStamp(token: string): PushCredential {
  return `token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
}

/** Static token and API key stamps: they outlive sessions, so only their own end (or a full
 *  "sign out everywhere") takes their rows. */
const lasting = (by: string) => by.startsWith('token:') || by.startsWith('key:')

/**
 * A sweep of the person's phone push rows: `ids` of person `u`, or (no ids) all of them, as they
 * stood at `at` (ms, taken after every credential in scope was ended). `keep` = what the caller
 * keeps signed in ("everywhere else"): its rows stay. Stored as a leftover when the database
 * refuses, and retried on this tenant's next phone sign-out.
 */
interface Leftover {
  u: string
  ids?: number[]
  at: number
  keep?: PushCredential[]
  /** false = a partial sign-out (other sessions, an admin's session sign-out): rows a static
   *  token or API key registered stay while that credential still works. Absent = full. */
  full?: boolean
}
/** Per tenant (cloud): leftovers are retried on this tenant's next phone sign-out. */
const leftoverKey = () => `nvr:device-push-leftover:${currentTenantKey()}`
/** A leftover this old is given up on (logged), so a stale sweep can never hit a far later row. */
const LEFTOVER_MAX_AGE_MS = 30 * 86_400_000

/** When each phone push row was last registered (POST /api/push/phones) and with what, per
 *  tenant. A stamp from before credentials were recorded (a bare number) counts as by nobody. */
const registeredKey = (rowId: number) => `nvr:phone-push-reg:${currentTenantKey()}:${rowId}`
const REGISTERED_TTL_S = 60 * 86_400 // outlives any leftover (≤ 30 days)

interface Stamp {
  at: number
  by: PushCredential | null
}
const readStamp = (raw: string | null): Stamp | null => {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v === 'number') return { at: v, by: null }
    const st = v as Partial<Stamp>
    if (!Number.isFinite(st?.at)) return null
    const by = typeof st.by === 'string' && CREDENTIAL_RE.test(st.by) ? st.by : null
    return { at: Number(st.at), by: by as PushCredential | null }
  } catch {
    return null
  }
}

/** Stamp a phone push row as registered now, by `by` (every registration, insert or update). */
export async function notePhoneRegistered(
  redis: Redis,
  rowId: number,
  by: PushCredential | null = null
): Promise<void> {
  if (!Number.isInteger(rowId) || rowId <= 0) return
  await redis.setex(registeredKey(rowId), REGISTERED_TTL_S, JSON.stringify({ at: Date.now(), by }))
}

/** Is the credential still signed in? A grant that stands; a session neither gone nor revoked. */
export async function credentialLive(
  redis: Redis,
  by: PushCredential,
  /** The person the row belongs to: a static token or API key must still be theirs. */
  userId?: string
): Promise<boolean> {
  if (by.startsWith('grant:')) return (await redis.exists(grantKey(by.slice(6)))) === 1
  if (by.startsWith('token:')) {
    if (!userId) return false
    const row = (await db('nivaro_users').where({ id: userId }).first('static_token')) as
      | { static_token?: string | null }
      | undefined
    return !!row?.static_token && staticTokenStamp(String(row.static_token)) === by
  }
  if (by.startsWith('key:')) {
    const id = Number(by.slice(4))
    if (!Number.isInteger(id) || id <= 0) return false
    const key = (await db('nivaro_api_keys')
      .where({ id })
      .first('id', 'user', 'is_active', 'expires_at')) as
      | {
          user?: string | null
          is_active?: boolean | number | null
          expires_at?: Date | string | null
        }
      | undefined
    if (!key || !key.is_active) return false
    if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return false
    return !userId || String(key.user ?? '').toUpperCase() === String(userId).toUpperCase()
  }
  const sid = by.slice(4)
  const [sess, revoked] = await redis.mget(`sess:${sid}`, `${REVOKED_PREFIX}${sid}`)
  return !!sess && !revoked
}

/** The push row ids a live sign-in of the person still holds (their grants' push sets). */
async function livePushIds(redis: Redis, userId: string): Promise<Set<number>> {
  const out = new Set<number>()
  for (const g of await listDeviceGrants(redis, userId))
    for (const id of await grantPushIds(redis, g.id)) out.add(id)
  return out
}

/**
 * Delete the person's phone push rows as they stood at `l.at` — `l.ids`, or all of them. Kept:
 * a row a live sign-in of the person holds; a row registered by a credential in `l.keep` that is
 * still signed in; a row
 * registered at or after `l.at` by a credential STILL signed in (the person signed in again on
 * that install since). A row whose credential is gone goes whatever its stamp says.
 */
async function deleteStaleRows(redis: Redis, l: Leftover): Promise<number> {
  if (l.ids && l.ids.length === 0) return 0
  const q = wherePhoneEndpoint(db('nivaro_push_subscriptions').where({ user: l.u }))
  if (l.ids) q.whereIn('id', l.ids)
  const rows = (await q.select('id')) as Array<{ id: number }>
  if (rows.length === 0) return 0
  const live = await livePushIds(redis, l.u)
  const ids = rows.map((r) => Number(r.id)).filter((id) => !live.has(id))
  if (ids.length === 0) return 0
  const keep = new Set<string>(l.keep ?? [])
  const stamps = (await redis.mget(...ids.map(registeredKey))).map(readStamp)
  const stale: number[] = []
  for (const [i, id] of ids.entries()) {
    const st = stamps[i]
    // A static token or API key outlives sessions: a partial sign-out keeps its row while it
    // still works; only its own end or a full sign-out takes it.
    if (st?.by && lasting(st.by)) {
      if (l.full === false && (await credentialLive(redis, st.by, l.u))) continue
      stale.push(id)
      continue
    }
    // Kept only while the registering credential is still signed in (asked once): a credential
    // in `keep`, or one that registered the row at or after the sweep.
    if (st?.by && (keep.has(st.by) || st.at >= l.at) && (await credentialLive(redis, st.by, l.u)))
      continue
    stale.push(id)
  }
  if (stale.length === 0) return 0
  return deleteGrantPushRows({ user_id: l.u, push_ids: stale })
}

/**
 * Delete push rows, or — the database refusing — keep them for the next phone sign-out on this
 * tenant to delete (the credential is already dead; only the alerts are left to stop).
 * `l.ids` = the rows a sign-in just handed back (deleted as they are); no ids = the backstop
 * sweep, which deletes only stale rows (deleteStaleRows).
 */
async function deleteOrKeep(redis: Redis, l: Leftover, req?: FastifyRequest): Promise<void> {
  if (l.ids && l.ids.length === 0) return
  try {
    if (l.ids) await deleteGrantPushRows({ user_id: l.u, push_ids: l.ids })
    else await deleteStaleRows(redis, l)
  } catch (err) {
    req?.log.warn({ err, user: l.u, push_ids: l.ids ?? 'all' }, 'phone push rows kept for retry')
    try {
      await redis.sadd(leftoverKey(), JSON.stringify(l))
    } catch {
      // Redis too: logged above, nothing more to do
    }
  }
}

/**
 * Delete these phone push rows of one person now — or, the database refusing, keep them for this
 * tenant's next phone sign-out to delete (POST /push/phones taking back a row whose credential
 * ended, or could not be checked, while it registered).
 */
export async function deletePushRowsOrKeep(
  redis: Redis,
  userId: string,
  ids: number[],
  req?: FastifyRequest
): Promise<void> {
  await deleteOrKeep(redis, { u: String(userId), ids, at: Date.now() }, req)
}

const isLeftover = (v: unknown): v is Leftover => {
  const l = v as Leftover
  return (
    !!l &&
    typeof l.u === 'string' &&
    Number.isFinite(l.at) &&
    (l.ids === undefined || (Array.isArray(l.ids) && l.ids.every(Number.isInteger))) &&
    (l.keep === undefined ||
      (Array.isArray(l.keep) && l.keep.every((k) => CREDENTIAL_RE.test(String(k))))) &&
    (l.full === undefined || typeof l.full === 'boolean')
  )
}

/**
 * Retry the push rows an earlier sign-out could not delete — only rows still stale by then
 * (deleteStaleRows). Damaged or expired entries are dropped with a log. Never throws.
 */
export async function retryLeftoverPushRows(redis: Redis, req?: FastifyRequest): Promise<void> {
  try {
    for (const raw of await redis.smembers(leftoverKey())) {
      let l: unknown
      try {
        l = JSON.parse(raw)
      } catch {
        l = null
      }
      if (!isLeftover(l) || Date.now() - l.at > LEFTOVER_MAX_AGE_MS) {
        req?.log.warn(
          { entry: raw.slice(0, 200) },
          'phone push leftover dropped (damaged or expired)'
        )
        await redis.srem(leftoverKey(), raw).catch(() => 0)
        continue
      }
      try {
        await deleteStaleRows(redis, l)
        await redis.srem(leftoverKey(), raw)
      } catch {
        // still refused: left for the next pass
      }
    }
  } catch {
    // Redis trouble: the next sign-out tries again
  }
}

/**
 * End one phone's sign-in. The credential dies first — the grant and every token, with its push
 * ids read in the same Redis transaction — then its push rows are deleted; a database error
 * keeps them for a retry (never leaves the phone signed in). `userId` limits it to that person's
 * phones. Returns the ended grant, or null when there is no such phone (here, on this tenant).
 * Logged as `device-revoked`.
 */
export async function endDeviceGrant(
  redis: Redis,
  grantId: string,
  reason: DeviceEndReason,
  opts: { userId?: string; adminId?: string; req?: FastifyRequest } = {}
): Promise<OAuthGrant | null> {
  const g = await getGrant(redis, grantId, 'device')
  if (!g) return null
  if (opts.userId && String(g.user_id).toUpperCase() !== String(opts.userId).toUpperCase())
    return null
  const ended = await takeGrant(redis, g.user_id, g.id, 'device')
  if (!ended) return null
  // Rows an earlier sign-out could not delete go first; then this phone's.
  await retryLeftoverPushRows(redis, opts.req)
  await deleteOrKeep(
    redis,
    { u: String(ended.user_id), ids: ended.push_ids ?? [], at: Date.now() },
    opts.req
  )
  await logActivity({
    action: 'device-revoked',
    user: opts.adminId ?? ended.user_id,
    collection: 'nivaro_users',
    item: String(ended.user_id),
    comment: `${deviceLabel(ended)}: ${REASON_TEXT[reason]}${opts.adminId ? ` (admin_id ${opts.adminId})` : ''}`,
    req: opts.req
  }).catch(() => null)
  return ended
}

/** The person's signed-in phones (any id case — grants are filed under the id as stored). */
export async function listDeviceGrants(redis: Redis, userId: string): Promise<OAuthGrant[]> {
  const variants = [...new Set([userId, userId.toUpperCase(), userId.toLowerCase()])]
  const seen = new Map<string, OAuthGrant>()
  for (const v of variants) for (const g of await listGrants(redis, v, 'device')) seen.set(g.id, g)
  return [...seen.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/**
 * Sign the person out on every phone (but `except`, the calling phone's own grant). Fails
 * closed: when any phone could not be signed out (after trying them all) the first error is
 * thrown, never a partial "done". Then every phone push row of the person is swept — a backstop
 * for a row no ended grant recorded — keeping only the caller's own: rows of the `except` grant
 * and rows registered by the `keepSid` session ("everywhere else" from a browser or a phone app
 * on a session). The sweep's time is taken only after everything in scope was ended, so a row
 * a just-ended credential registered meanwhile goes too. Returns how many phones were signed out.
 * Callers ending sessions too end them BEFORE this call.
 */
export async function endUserDeviceGrants(
  redis: Redis,
  userId: string,
  opts: {
    except?: string | null
    keepSid?: string | null
    reason?: DeviceEndReason
    req?: FastifyRequest
    /** false = a partial sign-out: static-token / API-key rows stay while they work. */
    full?: boolean
  } = {}
): Promise<number> {
  let ended = 0
  let failure: unknown = null
  for (const g of await listDeviceGrants(redis, userId)) {
    if (opts.except && g.id === opts.except) continue
    // Every phone is tried; one that could not be signed out fails the whole call afterwards.
    try {
      const done = await endDeviceGrant(redis, g.id, opts.reason ?? 'signed-out-everywhere', {
        userId,
        req: opts.req
      })
      if (done) ended++
    } catch (err) {
      failure ??= err
    }
  }
  if (failure) throw failure
  const keep: PushCredential[] = []
  if (opts.except) keep.push(`grant:${opts.except}`)
  if (opts.keepSid) keep.push(`sid:${opts.keepSid}`)
  // `at` only now: every grant in scope (and, before this call, every session) is ended.
  await deleteOrKeep(
    redis,
    { u: userId, at: Date.now(), keep, ...(opts.full === false ? { full: false } : {}) },
    opts.req
  )
  return ended
}

/**
 * Why a phone's sign-in is over although nobody ended it, or null while it stands: phone sign-in
 * is off (MOBILE_SIGNIN=off), its refresh token lapsed, the account is no longer active, or the
 * role's session policy (idle / max age) has passed. `account` = the person's row, read once
 * per person by the caller (undefined = not active).
 */
async function passiveEnd(
  redis: Redis,
  g: OAuthGrant,
  account: { role: string | null } | undefined,
  policy: Awaited<ReturnType<typeof getSessionPolicy>>
): Promise<string | null> {
  if (!mobileSignInEnabled()) return 'phone sign-in is off'
  if (!account) return 'account not active'
  if (!(await deviceRefreshLive(redis, g))) return 'refresh token lapsed'
  if (policy && !judgeDeviceGrant(limitsFor(policy, account.role), g, appNowForAuth()).ok)
    return 'past the session policy'
  return null
}

async function activeAccountOf(userId: string): Promise<{ role: string | null } | undefined> {
  const row = (await db('nivaro_users')
    .where({ id: userId, status: 'active' })
    .first('id', 'role')) as { id: string; role?: string | null } | undefined
  return row ? { role: row.role ?? null } : undefined
}

/**
 * The person's signed-in phones, ending (endDeviceGrant 'expired' — grant, tokens and push rows)
 * any whose sign-in is over with no action (passiveEnd). What the Signed-in phones lists show.
 * A failed check (database, Redis) keeps the phone listed: it never ends one on a guess.
 */
export async function liveDeviceGrants(
  redis: Redis,
  userId: string,
  req?: FastifyRequest
): Promise<OAuthGrant[]> {
  const grants = await listDeviceGrants(redis, userId)
  if (grants.length === 0) return grants
  let account: { role: string | null } | undefined
  let policy: Awaited<ReturnType<typeof getSessionPolicy>> = null
  try {
    account = await activeAccountOf(userId)
    policy = await getSessionPolicy()
  } catch (err) {
    req?.log.warn({ err }, 'signed-in phones: not checked for lapsed sign-ins')
    return grants
  }
  const out: OAuthGrant[] = []
  for (const g of grants) {
    const why = await passiveEnd(redis, g, account, policy).catch(() => null)
    if (!why) {
      out.push(g)
      continue
    }
    const ended = await endDeviceGrant(redis, g.id, 'expired', { userId, req }).catch(() => null)
    if (!ended) out.push(g)
  }
  return out
}

/**
 * The background pass (cron `device-grants-sweep`, where crons tick): every person with a phone
 * sign-in on this instance gets the liveDeviceGrants check. Returns how many phones it ended.
 */
export async function sweepDeviceGrants(redis: Redis): Promise<number> {
  const users = new Set<string>()
  for (const g of await listAllGrants(redis, 20_000, 'device')) users.add(String(g.user_id))
  let ended = 0
  for (const u of users) {
    const before = (await listDeviceGrants(redis, u)).length
    const after = (await liveDeviceGrants(redis, u)).length
    ended += before - after
  }
  return ended
}
