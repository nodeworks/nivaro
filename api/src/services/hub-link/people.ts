import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { whereEqualsCi } from '../../db/dialect/h2.js'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'

/**
 * Hub link (app side): the Hub's people directory and "Offboard everywhere".
 *
 *   POST /api/hub-link/people/lookup   {emails?, entra?} → {accounts}
 *   POST /api/hub-link/people/suspend  {emails?, entra?} → {state, accounts}
 *   (and the same two under /api/hub-deployment/apps/:id/people/* on a shared deployment,
 *   run inside that app)
 *
 * A person is matched ONLY by email (case-insensitive, exact) or by Entra object id (the tenant
 * must agree when both sides know it) — never by name. Only people accounts (`account_kind`
 * null): service, placeholder and machine accounts are never matched or suspended.
 *
 * Lookup answers per account: the app's user id, status, role NAME and whether that role has
 * admin access. Nothing else from the person's row, never a record.
 *
 * Suspend only, never delete: through the app's own user service (`updateUser`), so the identity
 * cache, default channels and revisions follow as for an administrator's edit; then every session
 * and phone sign-in ends (revokeUserSessions) and API keys stop with the account (authentication
 * reads only active accounts). Refused 409 LAST_ADMIN — nothing written — when it would leave the
 * app with no active administrator. An account already suspended is reported, not written again.
 * One activity row per suspended account ('hub-offboard', origin integration) and the usual
 * "accounts were suspended by offboarding" notice to the app's administrators.
 */

export const PEOPLE_MAX_IDS = 5
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

export interface PeopleQuery {
  emails: string[]
  entra: Array<{ oid: string; tid: string | null }>
}

export interface PersonAccount {
  user_id: string
  status: string
  role: string | null
  admin: boolean
  matched_by: 'entra' | 'email'
}

export type SuspendAnswer =
  | { ok: true; state: 'suspended' | 'already' | 'none'; accounts: PersonAccount[] }
  | { ok: false; status: 400 | 409; code: 'BAD_PERSON' | 'LAST_ADMIN'; message: string }

function cleanEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return s.length >= 3 && s.length <= 320 && EMAIL_RE.test(s) ? s : null
}

function cleanId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return ID_RE.test(s) ? s : null
}

/** The body as a query, or null (nothing usable, or more than PEOPLE_MAX_IDS of either kind). */
export function readPeopleQuery(body: unknown): PeopleQuery | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as { emails?: unknown; entra?: unknown }
  const rawEmails = b.emails === undefined ? [] : b.emails
  const rawEntra = b.entra === undefined ? [] : b.entra
  if (!Array.isArray(rawEmails) || !Array.isArray(rawEntra)) return null
  if (rawEmails.length > PEOPLE_MAX_IDS || rawEntra.length > PEOPLE_MAX_IDS) return null
  const emails: string[] = []
  for (const e of rawEmails) {
    const c = cleanEmail(e)
    if (!c) return null
    if (!emails.includes(c)) emails.push(c)
  }
  const entra: PeopleQuery['entra'] = []
  for (const x of rawEntra) {
    if (!x || typeof x !== 'object') return null
    const oid = cleanId((x as { oid?: unknown }).oid)
    const tidRaw = (x as { tid?: unknown }).tid
    const tid = tidRaw == null ? null : cleanId(tidRaw)
    if (!oid || (tidRaw != null && !tid)) return null
    if (!entra.some((y) => y.oid === oid)) entra.push({ oid, tid })
  }
  if (!emails.length && !entra.length) return null
  return { emails, entra }
}

interface Row {
  id: unknown
  email: unknown
  status: unknown
  entra_oid?: unknown
  entra_tid?: unknown
  role_name: unknown
  admin_access: unknown
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

/** People accounts matching the query, each once (an Entra match wins over an email match). */
export async function matchPeople(q: PeopleQuery, k: Knex = db): Promise<PersonAccount[]> {
  const hasEntra = q.entra.length > 0 && (await k.schema.hasColumn('nivaro_users', 'entra_oid'))
  // Nothing left to match on: never an empty condition (that would match everyone).
  if (!q.emails.length && !hasEntra) return []
  const rows = (await k('nivaro_users as u')
    .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
    .whereNull('u.account_kind')
    .where((w) => {
      for (const e of q.emails) w.orWhere((x) => whereEqualsCi(x, k, 'u.email', e))
      if (hasEntra)
        w.orWhereIn(
          'u.entra_oid',
          q.entra.map((x) => x.oid)
        )
    })
    .select(
      'u.id',
      'u.email',
      'u.status',
      ...(hasEntra ? ['u.entra_oid', 'u.entra_tid'] : []),
      'r.name as role_name',
      'r.admin_access as admin_access'
    )
    .limit(50)) as Row[]
  const out: PersonAccount[] = []
  for (const r of rows) {
    const oid = typeof r.entra_oid === 'string' ? r.entra_oid.toLowerCase() : null
    const tid = typeof r.entra_tid === 'string' ? r.entra_tid.toLowerCase() : null
    const asked = oid ? q.entra.find((x) => x.oid === oid) : undefined
    // The tenant must agree when both sides know it; a mismatch is a different person.
    const entraMatch = !!asked && (!asked.tid || !tid || asked.tid === tid)
    const email = typeof r.email === 'string' ? r.email.trim().toLowerCase() : ''
    const emailMatch = q.emails.includes(email)
    if (!entraMatch && !emailMatch) continue
    const id = String(r.id)
    if (out.some((a) => a.user_id.toUpperCase() === id.toUpperCase())) continue
    out.push({
      user_id: id,
      status: String(r.status ?? ''),
      role: r.role_name == null ? null : String(r.role_name),
      admin: truthy(r.admin_access),
      matched_by: entraMatch ? 'entra' : 'email'
    })
  }
  return out
}

/** Active administrator people (the infra-drift/first-admin rule), ids upper-cased. */
async function activeAdminIds(k: Knex): Promise<string[]> {
  const rows = (await k('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .select('u.id')) as Array<{ id: unknown }>
  return rows.map((r) => String(r.id).toUpperCase())
}

export interface SuspendDeps {
  k?: Knex
  /** The app's Redis (session store): every session and phone sign-in of the person ends. */
  redis?: unknown
  app?: FastifyInstance
  updateUser?: (id: string, data: { status: string }) => Promise<unknown>
  revokeUserSessions?: (redis: unknown, userId: string) => Promise<number>
}

/** Suspends every matched account (see the header). Never deletes; never touches a non-person. */
export async function suspendPeople(body: unknown, deps: SuspendDeps = {}): Promise<SuspendAnswer> {
  const q = readPeopleQuery(body)
  if (!q)
    return {
      ok: false,
      status: 400,
      code: 'BAD_PERSON',
      message: `Give up to ${PEOPLE_MAX_IDS} emails and/or Entra object ids`
    }
  const k = deps.k ?? db
  const accounts = await matchPeople(q, k)
  if (!accounts.length) return { ok: true, state: 'none', accounts: [] }
  const toSuspend = accounts.filter((a) => a.status.toLowerCase() !== 'suspended')
  if (!toSuspend.length) return { ok: true, state: 'already', accounts }

  const leaving = new Set(toSuspend.map((a) => a.user_id.toUpperCase()))
  const admins = await activeAdminIds(k)
  if (admins.some((id) => leaving.has(id)) && admins.every((id) => leaving.has(id)))
    return {
      ok: false,
      status: 409,
      code: 'LAST_ADMIN',
      message:
        'This person is the last active administrator here; make someone else an administrator first'
    }

  const update =
    deps.updateUser ??
    (async (id: string, data: { status: string }) => {
      const { updateUser } = await import('../users.js')
      return updateUser(id, data as never)
    })
  const revoke =
    deps.revokeUserSessions ??
    (async (redis: unknown, id: string) => {
      const { revokeUserSessions } = await import('../../auth/session.js')
      return revokeUserSessions(redis as never, id)
    })
  for (const a of toSuspend) {
    await update(a.user_id, { status: 'suspended' })
    // Sessions and phones end now; a store that cannot be reached leaves them to the account
    // check every request makes (only active accounts authenticate).
    if (deps.redis) await revoke(deps.redis, a.user_id).catch(() => 0)
    await logActivity({
      action: 'hub-offboard',
      user: null,
      collection: 'nivaro_users',
      item: a.user_id,
      comment: 'Suspended by the Nivaro Hub (offboarded everywhere)',
      origin: 'integration'
    })
  }
  try {
    const { noteUsersDeactivated } = await import('../inactive-people-notice.js')
    noteUsersDeactivated(
      toSuspend.map((a) => a.user_id),
      { reason: 'offboarding', ...(deps.app ? { app: deps.app } : {}) }
    )
  } catch {
    // The notice is a courtesy; the suspension stands.
  }
  return {
    ok: true,
    state: 'suspended',
    accounts: accounts.map((a) =>
      leaving.has(a.user_id.toUpperCase()) ? { ...a, status: 'suspended' } : a
    )
  }
}

/** The lookup answer: 400 BAD_PERSON for an unusable body. */
export async function lookupPeople(
  body: unknown,
  k: Knex = db
): Promise<{ ok: true; accounts: PersonAccount[] } | { ok: false; status: 400; code: string }> {
  const q = readPeopleQuery(body)
  if (!q) return { ok: false, status: 400, code: 'BAD_PERSON' }
  return { ok: true, accounts: await matchPeople(q, k) }
}
