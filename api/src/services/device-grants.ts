import type { FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { REVOKED_PREFIX } from '../auth/session.js'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import {
  getGrant,
  grantKey,
  grantPushIds,
  listGrants,
  type OAuthGrant,
  takeGrant
} from './oauth-store.js'
import { wherePhoneEndpoint } from './push-relay.js'
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
export type PushCredential = `grant:${string}` | `sid:${string}`

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
    const by = typeof st.by === 'string' && /^(grant|sid):./.test(st.by) ? st.by : null
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
export async function credentialLive(redis: Redis, by: PushCredential): Promise<boolean> {
  if (by.startsWith('grant:')) return (await redis.exists(grantKey(by.slice(6)))) === 1
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
 * a row a live sign-in of the person holds; a row registered by a credential in `l.keep`; a row
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
    if (st?.by && keep.has(st.by)) continue
    if (st?.by && st.at >= l.at && (await credentialLive(redis, st.by))) continue
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

const isLeftover = (v: unknown): v is Leftover => {
  const l = v as Leftover
  return (
    !!l &&
    typeof l.u === 'string' &&
    Number.isFinite(l.at) &&
    (l.ids === undefined || (Array.isArray(l.ids) && l.ids.every(Number.isInteger))) &&
    (l.keep === undefined ||
      (Array.isArray(l.keep) && l.keep.every((k) => /^(grant|sid):./.test(String(k)))))
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
  await deleteOrKeep(redis, { u: userId, at: Date.now(), keep }, opts.req)
  return ended
}
