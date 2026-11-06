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

// ─── The server gate (army 4 B1) ──────────────────────────────────────────────
/**
 * What a person still in the new-user flow may call. Everything else answers 403
 * ACCESS_PENDING (middleware/authenticate.ts): before this gate a First Access account could run
 * every `authenticated` custom query, read through GraphQL and call extension routes unscoped.
 *
 * The list is what the Request-access screen and the shell around it call (efp-new
 * AwaitingAuthorization + AppShell before its gate + main.tsx; the phone app's waiting screen):
 * sign-in / sign-out / View-as exit / ws token (`/auth/*`), the request itself and its own
 * preferences, the two pickers the form fills (divisions, vendors: GET only — the First Access
 * policies narrow their fields), maintenance notices, the error reporter, timings, the phone's
 * own push registration, and the OAuth sign-in pages (a token they mint still meets this gate).
 *
 * Exact paths (query string ignored) — a variant spelling is refused, never let through.
 */
const PENDING_PREFIXES = ['/api/auth/', '/oauth/', '/.well-known/']
const PENDING_EXACT: Record<string, ReadonlySet<string>> = {
  '/api/users/me': new Set(['GET', 'HEAD']),
  '/api/users/me/access-request': new Set(['GET', 'HEAD', 'POST']),
  '/api/users/me/preferences': new Set(['GET', 'HEAD', 'PATCH']),
  '/api/users/me/deletion-request': new Set(['GET', 'HEAD', 'POST']),
  '/api/items/divisions': new Set(['GET', 'HEAD']),
  '/api/items/vendors': new Set(['GET', 'HEAD']),
  '/api/announcements/active': new Set(['GET', 'HEAD']),
  '/api/app-info': new Set(['GET', 'HEAD']),
  '/api/issues/client': new Set(['POST']),
  '/api/rum': new Set(['POST']),
  '/api/push/phones': new Set(['GET', 'HEAD', 'POST', 'DELETE'])
}

export function accessPendingRouteAllowed(method: string, url: string): boolean {
  const q = url.indexOf('?')
  let path = q === -1 ? url : url.slice(0, q)
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  const m = method.toUpperCase()
  const exact = PENDING_EXACT[path]
  if (exact) return exact.has(m)
  return PENDING_PREFIXES.some((p) => path.startsWith(p))
}

/** The refusal an access-pending person gets everywhere outside the list above. */
export const ACCESS_PENDING_MESSAGE =
  'Your access request is waiting for an administrator. You can use the portal once it is approved.'

/**
 * The verdict for a sign-in judged outside a request (a socket, a stream): pending, unless
 * the credential is an API key (never in the flow) or the role grants admin access (one role
 * read, only for someone on a flow role). Fails open like accessPendingFor.
 */
export async function accessPendingSignIn(
  user: { role?: string | null; preferences?: unknown },
  credentialKind: string
): Promise<boolean> {
  if (credentialKind === 'apikey' || !user.role) return false
  if (!(await accessPendingFor(user, false))) return false
  try {
    const role = (await db('nivaro_roles').where({ id: user.role }).first('admin_access')) as
      | { admin_access?: boolean | number | null }
      | undefined
    return !role?.admin_access
  } catch {
    return false
  }
}
