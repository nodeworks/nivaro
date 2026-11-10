import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { isMachineAccount } from './machine-accounts.js'
import { notifyUser } from './notification-channels.js'

/**
 * POST /users/me/access-request — what a provisional account (the role
 * nivaro_settings.new_user_role hands a first sign-in) asks for: the parts
 * the route uses, kept pure where they can be (army 4 a09-2 / a09-4).
 */

/** The notification rules row access-request notices to admins file under: `workflow`
 *  ("something is waiting on you"), not `system` — admins mute `system` for import and
 *  monitor noise, and a muted access request leaves a new hire stuck awaiting authorization. */
export const ACCESS_REQUEST_NOTIFY_CATEGORY = 'workflow' as const

/** Longest reason the server stores; a longer one is refused, never cut. */
export const ACCESS_REASON_MAX = 2000
const MAX_DIVISIONS = 50

type Id = string | number

export interface PortalAccessRequest {
  divisions: Id[]
  vendor: Id | null
  vendor_name: string | null
  reason: string
  submitted_at: string
}

export type ParsedRequest =
  | { ok: true; value: Omit<PortalAccessRequest, 'submitted_at'> }
  | { ok: false; error: string; code: string }

const isId = (v: unknown): v is Id =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '')

/** The body, shaped and bounded. Ids are checked against their tables separately. */
export function parseAccessRequestBody(body: unknown): ParsedRequest {
  const b = (body ?? {}) as Record<string, unknown>
  const reason = String(b.reason ?? '').trim()
  if (!reason) return { ok: false, error: 'reason is required', code: 'REASON_REQUIRED' }
  if (reason.length > ACCESS_REASON_MAX)
    return {
      ok: false,
      error: `The reason can be at most ${ACCESS_REASON_MAX} characters.`,
      code: 'REASON_TOO_LONG'
    }
  const divisions = Array.isArray(b.divisions)
    ? [
        ...new Set(
          (b.divisions as unknown[]).filter(isId).map((v) => (typeof v === 'string' ? v.trim() : v))
        )
      ]
    : []
  const vendor = isId(b.vendor) ? b.vendor : null
  return {
    ok: true,
    value: {
      divisions: divisions.slice(0, MAX_DIVISIONS),
      vendor,
      vendor_name:
        vendor == null || b.vendor_name == null ? null : String(b.vendor_name).slice(0, 500),
      reason
    }
  }
}

/** Two requests ask for the same thing (order of zones aside). */
export function sameRequest(
  prev: Partial<PortalAccessRequest> | null | undefined,
  next: Omit<PortalAccessRequest, 'submitted_at'>
): boolean {
  if (!prev) return false
  const zones = (v: unknown) => (Array.isArray(v) ? v : []).map(String).sort().join('\u0001')
  return (
    zones(prev.divisions) === zones(next.divisions) &&
    String(prev.vendor ?? '') === String(next.vendor ?? '') &&
    String(prev.reason ?? '').trim() === next.reason
  )
}

/**
 * What a submit does: it writes (and logs one activity row) only when the
 * request changed or the account moves into the review role; admins are told
 * once — the first request, or the move — never on a resend.
 */
export function accessRequestOutcome(
  prev: PortalAccessRequest | null,
  changed: boolean,
  roleChanged: boolean
): { write: boolean; notify: boolean; comment: string } {
  const write = changed || roleChanged
  return {
    write,
    notify: write && (!prev || roleChanged),
    comment: roleChanged ? 'submitted; moved to the review role' : prev ? 'updated' : 'submitted'
  }
}

/**
 * Only an account still in the new-user flow may file a request (army9 b10):
 * no role yet, the new-user role, or the review role. Anyone else — an
 * authorized person, an administrator, or any account when the flow is not
 * configured — would otherwise store a request nobody lists and tell every
 * administrator about it. Role ids compare case-blind.
 */
export function mayRequestAccess(
  currentRole: string | null,
  startRole: string | null,
  reviewRole: string | null,
  isAdmin: boolean
): boolean {
  if (isAdmin) return false
  const up = (v: string | null) => (v ? v.toUpperCase() : null)
  const role = up(currentRole)
  if (role === null) return true
  return role === up(startRole) || role === up(reviewRole)
}

/** The stored request, if the preferences carry one. */
export function storedRequest(
  prefs: Record<string, unknown> | null | undefined
): PortalAccessRequest | null {
  const r = prefs?.access_request as PortalAccessRequest | undefined
  return r && typeof r === 'object' && Array.isArray(r.divisions) ? r : null
}

/**
 * The ids (of those given) that exist in `table`. A database without that
 * table (a Nivaro install that has no such collection) keeps the ids as given.
 * Numeric and text ids are asked separately so a junk value never makes the
 * whole read fail on a type conversion — a failed read keeps nothing.
 */
export async function existingIds(table: string, ids: Id[]): Promise<Id[]> {
  if (ids.length === 0) return []
  if (!(await db.schema.hasTable(table).catch(() => false))) return ids
  const numeric = ids.filter((v) => typeof v === 'number' || /^\d{1,15}$/.test(String(v)))
  const text = ids.filter((v) => !numeric.includes(v))
  const found = new Set<string>()
  const ask = async (values: Id[]) => {
    if (values.length === 0) return
    try {
      const rows = (await db(table).whereIn('id', values).select('id')) as Array<{ id: Id }>
      for (const r of rows) found.add(String(r.id).toUpperCase())
    } catch {
      // A value the id column cannot hold — none of these exist.
    }
  }
  await ask(numeric.map((v) => (typeof v === 'number' ? v : Number(v))))
  await ask(text)
  return ids.filter((v) => found.has(String(v).toUpperCase()))
}

/**
 * Tell every active administrator (people, not machine accounts) that a
 * request is waiting. Through notifyUser only — inbox, push and each admin's
 * own notification rules. Returns how many were told.
 */
export async function notifyAdminsOfAccessRequest(
  app: FastifyInstance,
  requester: { id: string; name: string },
  request: Pick<PortalAccessRequest, 'reason'>
): Promise<number> {
  const admins = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where((qb) => void qb.where('u.status', 'active').orWhereNull('u.status'))
    .limit(50)
    .select('u.id', 'u.email', 'u.account_kind')) as Array<{
    id: string
    email?: string | null
    account_kind?: string | null
  }>
  const people = admins.filter(
    (a) => !isMachineAccount(a) && String(a.id).toUpperCase() !== requester.id.toUpperCase()
  )
  const reason = request.reason.length > 200 ? `${request.reason.slice(0, 200)}…` : request.reason
  let told = 0
  for (const a of people) {
    const res = await notifyUser(app, String(a.id), {
      subject: `${requester.name} asked for access to the portal`,
      message: `“${reason}” Review it under People → Awaiting authorization.`,
      sender: requester.id,
      // army7 b10: a real category, so admins can route or mute these under
      // Profile → Notification rules (and ask for email) — never "other".
      category: ACCESS_REQUEST_NOTIFY_CATEGORY,
      target: { kind: 'access_request', action: 'review' },
      // Rob 2026-11-10: admins are emailed every portal access request (the requester sits in
      // Needs Authorization until one of them acts), whatever their own rules say for the
      // category — a request seen only in the inbox waited days.
      channels: { email: true }
    }).catch(() => null)
    if (res) told++
  }
  return told
}

/**
 * army6 L46 — the vendor a request names, read by id on the server. The name
 * shown to admins is the vendor's own name, never text the client sent. null
 * when the id names no vendor. A database with no `vendors` table keeps the id
 * and has no name to show.
 */
export async function vendorOf(id: Id | null): Promise<{ id: Id; name: string | null } | null> {
  if (id == null) return null
  if (!(await db.schema.hasTable('vendors').catch(() => false))) return { id, name: null }
  const key = typeof id === 'number' || /^\d{1,15}$/.test(String(id)) ? Number(id) : String(id)
  let row: { id: Id; name?: unknown } | undefined
  try {
    row = (await db('vendors').where('id', key).first('id', 'name')) as typeof row
  } catch {
    try {
      // A vendors table with no name column: the id still counts.
      row = (await db('vendors').where('id', key).first('id')) as typeof row
    } catch {
      return null
    }
  }
  if (!row) return null
  const name = typeof row.name === 'string' ? row.name.trim().slice(0, 500) : ''
  return { id: row.id, name: name || null }
}

/** One authorization: the role, and either the zones it is limited to or every zone. */
export type AuthorizationPlan =
  | { ok: true; role: string; zones: Id[] | 'all' }
  | { ok: false; error: string; code: string }

/**
 * army6 L45 — approving with every zone unticked used to grant unrestricted
 * access by accident. "Every zone" must now be asked for (`all_zones: true`);
 * otherwise at least one zone is required.
 */
export function planAuthorization(body: unknown): AuthorizationPlan {
  const b = (body ?? {}) as Record<string, unknown>
  const role = typeof b.role === 'string' ? b.role.trim() : ''
  if (!role) return { ok: false, error: 'Choose a role.', code: 'ROLE_REQUIRED' }
  if (b.all_zones === true) return { ok: true, role, zones: 'all' }
  const zones = Array.isArray(b.zones)
    ? [...new Set((b.zones as unknown[]).filter(isId))].slice(0, MAX_DIVISIONS)
    : []
  if (zones.length === 0)
    return {
      ok: false,
      error: 'Pick at least one zone, or tick "All zones" to give access to every zone.',
      code: 'ZONES_REQUIRED'
    }
  return { ok: true, role, zones }
}
