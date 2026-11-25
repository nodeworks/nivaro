/**
 * Break-glass grants, the app's own read-time judgement (Hub enhancement 45). Leaf module: no
 * imports, so middleware/authenticate.ts can call it on every request for free.
 *
 * While a Nivaro Hub break-glass grant holds a person's account, `nivaro_users.break_glass` is
 * JSON `{ref, until, role, prev_role, at}`: the account's role was swapped to the admin role
 * `role` until `until`, and was `prev_role` before. The Hub revokes at `until`, the app's own job
 * (hub-break-glass-expire) revokes too — and in between, every request the person makes is judged
 * here: once `until` has passed, the request runs with `prev_role` already, so a grant can never
 * outlive its expiry by a missed job or an unreachable Hub.
 *
 * Only while the role is still the granted one: an administrator who changed the person's role
 * during the grant decided on purpose, and that stands.
 */

export interface BreakGlassMark {
  ref: string
  /** ISO time the grant ends. */
  until: string
  /** The admin role id the grant set. */
  role: string
  /** The role id the account had before (null = none). */
  prev_role: string | null
  at: string
}

const REF_RE = /^bg-[1-9][0-9]{0,11}$/

/** The stored mark, or null (missing, not JSON, or not a mark). Never throws. */
export function readBreakGlassMark(raw: unknown): BreakGlassMark | null {
  if (raw == null || raw === '') return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const m = v as Record<string, unknown>
  if (typeof m.ref !== 'string' || !REF_RE.test(m.ref)) return null
  if (typeof m.until !== 'string' || !Number.isFinite(Date.parse(m.until))) return null
  if (typeof m.role !== 'string' || !m.role) return null
  const prev = m.prev_role == null ? null : String(m.prev_role)
  return {
    ref: m.ref,
    until: m.until,
    role: m.role,
    prev_role: prev,
    at: typeof m.at === 'string' ? m.at : ''
  }
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

/**
 * The role a request by this account runs with: `prev_role` when the account's grant has ended
 * and its role is still the granted one, else the account's own role. `expired` says the app
 * should put the role back now (the caller starts that in the background).
 */
export function breakGlassRoleFor(
  user: { role?: unknown; break_glass?: unknown },
  now: number = Date.now()
): { role: unknown; expired: boolean } {
  const mark = readBreakGlassMark(user.break_glass)
  if (!mark) return { role: user.role, expired: false }
  if (Date.parse(mark.until) > now) return { role: user.role, expired: false }
  if (!same(user.role, mark.role)) return { role: user.role, expired: true }
  return { role: mark.prev_role, expired: true }
}
