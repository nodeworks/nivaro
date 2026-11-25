/**
 * Break-glass grants, the pure rules (Hub enhancement 45). Leaf module: no imports.
 *
 * A grant (app table nivaro_break_glass_grants) gave an account the app's admin role until
 * `ends_at`, and remembers the role it had (`prev_role`). The rules every judge shares — the
 * request path (middleware/authenticate.ts through services/break-glass-grants.ts), the app's
 * expiry job, the Hub's revoke, isActiveAdmin:
 *
 *  - A grant whose end time cannot be read counts as ENDED (fail closed).
 *  - When a grant ends, the saved role comes back whenever the account's role now carries admin
 *    access (the granted role, or any other admin role someone set meanwhile — a grantee can never
 *    keep admin by moving to another admin role). A role changed to one WITHOUT admin access is
 *    kept: someone took access away on purpose.
 */

export interface GrantRow {
  id: number
  ref: string
  user_id: string | null
  role: string | null
  prev_role: string | null
  ends_at: string | null
  /** When the grant began (credentials made since then are revoked at its end). */
  granted_at?: string | null
}

const ms = (v: unknown): number => {
  if (v == null || v === '') return Number.NaN
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v))
  return d.getTime()
}

/** Ended: its time ran out, or its end time cannot be read. Pure. */
export function grantEnded(g: Pick<GrantRow, 'ends_at'>, now: number = Date.now()): boolean {
  const end = ms(g.ends_at)
  return !Number.isFinite(end) || end <= now
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

/**
 * What happens to the account's role when its grant ends: `restore` (back to prev_role) when the
 * current role is the granted one or carries admin access, else `keep`. Pure.
 */
export function roleAfterGrant(
  current: { id: unknown; admin_access?: unknown } | null | undefined,
  g: Pick<GrantRow, 'role'>
): 'restore' | 'keep' {
  if (!current) return 'keep'
  if (same(current.id, g.role)) return 'restore'
  const admin =
    current.admin_access === true || current.admin_access === 1 || current.admin_access === '1'
  return admin ? 'restore' : 'keep'
}

/** The grant's end time: the earlier of the Hub's `until` and the app's own now + hours. Pure. */
export function grantEndsAt(hours: number, until: number | null, now: number = Date.now()): Date {
  const own = now + hours * 3_600_000
  return new Date(until != null && Number.isFinite(until) ? Math.min(own, until) : own)
}
