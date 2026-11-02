import { db } from '../db/index.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Where a person stands in the new-user flow (migration 330), for `/auth/me` `access_pending`:
 *
 *   'first_access'         on `nivaro_settings.new_user_role` (the role a first sign-in gets)
 *                          and no access request sent yet
 *   'needs_authorization'  on `nivaro_settings.access_request_role` (where a sent request moves
 *                          the account), or on the first role with a request sent
 *                          (`preferences.access_request`, POST /users/me/access-request)
 *   null                   not pending: any other role, an administrator, no role, or the flow
 *                          not configured
 *
 * Judged by the settings' role ids only, never by a role's name.
 */
export type AccessPending = null | 'first_access' | 'needs_authorization'

interface FlowSettings {
  new_user_role?: string | null
  access_request_role?: string | null
}

const up = (v: unknown) => (v == null || v === '' ? null : String(v).toUpperCase())

function requestSent(preferences: unknown): boolean {
  let prefs = preferences
  if (typeof prefs === 'string') {
    try {
      prefs = JSON.parse(prefs)
    } catch {
      return false
    }
  }
  const req = (prefs as { access_request?: { submitted_at?: unknown } } | null)?.access_request
  return !!req && typeof req === 'object' && !!req.submitted_at
}

export function accessPendingOf(
  user: { role?: string | null; preferences?: unknown },
  settings: FlowSettings | null | undefined,
  isAdmin: boolean
): AccessPending {
  if (isAdmin) return null
  const role = up(user.role)
  if (!role) return null
  const onStart = role === up(settings?.new_user_role)
  const onReview = role === up(settings?.access_request_role)
  if (!onStart && !onReview) return null
  if (onReview && !onStart) return 'needs_authorization'
  return requestSent(user.preferences) ? 'needs_authorization' : 'first_access'
}

/** The two settings, per tenant, for a short while: /auth/me is a hot path. A change to the
 *  new-user roles shows within SETTINGS_TTL_MS. */
const SETTINGS_TTL_MS = 30_000
const SETTINGS_MAX = 1000
const settingsCache = new Map<string, { at: number; value: FlowSettings | null }>()

async function flowSettings(): Promise<FlowSettings | null> {
  const key = currentTenantKey()
  const hit = settingsCache.get(key)
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value
  const value = ((await db('nivaro_settings').first('new_user_role', 'access_request_role')) ??
    null) as FlowSettings | null
  if (settingsCache.size >= SETTINGS_MAX) settingsCache.clear()
  settingsCache.set(key, { at: Date.now(), value })
  return value
}

/** Test hook: forget the cached settings. */
export function resetAccessPendingCache(): void {
  settingsCache.clear()
}

/** accessPendingOf with the (cached) settings; a failed read answers null (never blocks). */
export async function accessPendingFor(
  user: { role?: string | null; preferences?: unknown },
  isAdmin: boolean
): Promise<AccessPending> {
  if (isAdmin || !user.role) return null
  try {
    return accessPendingOf(user, await flowSettings(), isAdmin)
  } catch {
    return null
  }
}
