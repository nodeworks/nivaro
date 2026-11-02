import type { FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { getGrant, listGrants, type OAuthGrant, takeGrant } from './oauth-store.js'
import { wherePhoneEndpoint } from './push-relay.js'

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
 * End one phone's sign-in: its push rows go first (a database error throws and leaves the grant,
 * so the caller can retry), then the grant and its tokens; a push id added meanwhile is removed
 * too. `userId` limits it to that person's phones. Returns the ended grant, or null when there is
 * no such phone (here, on this tenant). Logged as `device-revoked`.
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
  await deleteGrantPushRows(g)
  const ended = await takeGrant(redis, g.user_id, g.id, 'device')
  if (!ended) return null
  const late = (ended.push_ids ?? []).filter((id) => !(g.push_ids ?? []).includes(id))
  if (late.length) await deleteGrantPushRows({ ...ended, push_ids: late }).catch(() => 0)
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
 * thrown, never a partial "done". Returns how many phones were signed out.
 */
export async function endUserDeviceGrants(
  redis: Redis,
  userId: string,
  opts: { except?: string | null; reason?: DeviceEndReason; req?: FastifyRequest } = {}
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
  return ended
}
