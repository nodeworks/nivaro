import type { FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { getGrant, grantPushIds, listGrants, type OAuthGrant, takeGrant } from './oauth-store.js'
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
 * Push rows a database error kept: `ids` of person `u`, or (no ids) all of `u`'s phone rows, as
 * they stood at `at` (ms) — the sign-out that could not delete them.
 */
interface Leftover {
  u: string
  ids?: number[]
  at: number
}
/** Per tenant (cloud): leftovers are retried on this tenant's next phone sign-out. */
const leftoverKey = () => `nvr:device-push-leftover:${currentTenantKey()}`
/** A leftover this old is given up on (logged), so a stale sweep can never hit a far later row. */
const LEFTOVER_MAX_AGE_MS = 30 * 86_400_000

/** When each phone push row was last registered (POST /api/push/phones), per tenant. */
const registeredKey = (rowId: number) => `nvr:phone-push-reg:${currentTenantKey()}:${rowId}`
const REGISTERED_TTL_S = 60 * 86_400 // outlives any leftover (≤ 30 days)

/** Stamp a phone push row as registered now (every registration, insert or update). */
export async function notePhoneRegistered(redis: Redis, rowId: number): Promise<void> {
  if (!Number.isInteger(rowId) || rowId <= 0) return
  await redis.setex(registeredKey(rowId), REGISTERED_TTL_S, String(Date.now()))
}

/** The push row ids a live sign-in of the person still holds (their grants' push sets). */
async function livePushIds(redis: Redis, userId: string): Promise<Set<number>> {
  const out = new Set<number>()
  for (const g of await listDeviceGrants(redis, userId))
    for (const id of await grantPushIds(redis, g.id)) out.add(id)
  return out
}

/**
 * Delete the person's phone push rows as they stood at `l.at` — `l.ids`, or all of them — but
 * never one a live sign-in holds, nor one registered at or after `l.at` (the person signed in
 * again on that install since: deleting it would silence a live phone).
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
  const stamps = await redis.mget(...ids.map(registeredKey))
  const stale = ids.filter((_, i) => !(Number(stamps[i]) >= l.at))
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
    (l.ids === undefined || (Array.isArray(l.ids) && l.ids.every(Number.isInteger)))
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
 * thrown, never a partial "done". `sweepAll` (a full sign-out: nothing of the caller stays
 * signed in) also deletes every stale phone push row of the person — a backstop for a row no
 * grant recorded. Returns how many phones were signed out.
 */
export async function endUserDeviceGrants(
  redis: Redis,
  userId: string,
  opts: {
    except?: string | null
    sweepAll?: boolean
    reason?: DeviceEndReason
    req?: FastifyRequest
  } = {}
): Promise<number> {
  const at = Date.now()
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
  if (opts.sweepAll && !opts.except) await deleteOrKeep(redis, { u: userId, at }, opts.req)
  return ended
}
