import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { isMachineAccount } from './machine-accounts.js'
import { notifyUser } from './notification-channels.js'

/**
 * POST /users/me/access-request — what a provisional account (the role
 * nivaro_settings.new_user_role hands a first sign-in) asks for: the parts
 * the route uses, kept pure where they can be (army 4 a09-2 / a09-4).
 */

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
      target: { kind: 'access_request', action: 'review' }
    }).catch(() => null)
    if (res) told++
  }
  return told
}
