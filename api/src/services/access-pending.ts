import { db } from '../db/index.js'

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

/** accessPendingOf with the settings row read; a failed read answers null (never blocks). */
export async function accessPendingFor(
  user: { role?: string | null; preferences?: unknown },
  isAdmin: boolean
): Promise<AccessPending> {
  if (isAdmin || !user.role) return null
  try {
    const settings = (await db('nivaro_settings').first('new_user_role', 'access_request_role')) as
      | FlowSettings
      | undefined
    return accessPendingOf(user, settings, isAdmin)
  } catch {
    return null
  }
}
