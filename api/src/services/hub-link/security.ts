import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import {
  afterGrantEnded,
  endGrantInTrx,
  expireGrants,
  GRANTS,
  grantFromRow,
  grantsTableReady
} from '../break-glass-grants.js'
import { grantEnded, grantEndsAt } from '../break-glass-role.js'
import { matchPeople, readPeopleQuery } from './people.js'

/**
 * Hub link (app side, 0.3.215+): what the Nivaro Hub's security features ask of an app.
 *
 *   GET  security/role-holders   → {version, accounts, total, truncated}   access reviews (41)
 *   POST security/break-glass    {ref, emails?, entra?, hours, until?, reason, requested_by?,
 *                                 approved_by?} → {state: granted | already_admin, user_id, until}
 *   POST security/break-glass/revoke {ref, user_id? | emails?, entra?}
 *                                → {state: revoked | none | role_changed | restored_over_change,
 *                                   changed_by?, changed_to?, activity_count?}
 *
 * Mounted inside the hub link (`/api/hub-link/security/*`) and the deployment link
 * (`/api/hub-deployment/apps/:id/security/*`), each behind that link's bearer check.
 *
 * Break-glass (the table nivaro_break_glass_grants, services/break-glass-grants.ts):
 *  - the person is matched STRICTLY for a grant: an Entra object id the Hub knows must be the
 *    account's own (an account with no or another oid is refused IDENTITY_MISMATCH); an email
 *    match counts only when neither side has an oid. Exactly one active people account; a grant
 *    never creates, reactivates or un-suspends an account;
 *  - its end is the app's own now + hours (capped at 24 h), or the Hub's `until` if sooner —
 *    the app's clock decides, not the Hub's;
 *  - one row per ref (unique): a revoke that arrives before its grant leaves a tombstone, so the
 *    late grant is refused REF_ENDED (and logged); two grants of one ref never both land;
 *  - the role swap runs in one transaction under the admin role lock (first-admin.ts).
 */

export const ROLE_HOLDERS_MAX = 5000
export const BREAK_GLASS_MAX_HOURS = 24
const REF_RE = /^bg-[1-9][0-9]{0,11}$/
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

const truthy = (v: unknown) => v === true || v === 1 || v === '1'
const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const clip = (v: unknown, n: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null

export interface RoleHolder {
  user_id: string
  name: string | null
  email: string | null
  entra_oid: string | null
  role: string | null
  admin: boolean
  status: string
  kind: string | null
  last_access: string | null
  created_at: string | null
  break_glass_until: string | null
}

/** Every account with a role (not placeholders): admins first, newest sign-in first. */
export async function listRoleHolders(
  k: Knex = db
): Promise<{ accounts: RoleHolder[]; total: number; truncated: boolean }> {
  const hasOid = await k.schema.hasColumn('nivaro_users', 'entra_oid')
  const rows = (await k('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where((w) => w.whereNull('u.account_kind').orWhereNot('u.account_kind', 'placeholder'))
    .select(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.status',
      'u.account_kind',
      'u.last_access',
      'u.created_at',
      ...(hasOid ? ['u.entra_oid'] : []),
      'r.name as role_name',
      'r.admin_access as admin_access'
    )
    .limit(ROLE_HOLDERS_MAX + 1)) as Array<Record<string, unknown>>
  const truncated = rows.length > ROLE_HOLDERS_MAX
  const live = new Map<string, string | null>()
  if (await grantsTableReady(k)) {
    const g = (await k(GRANTS)
      .whereNull('ended_at')
      .whereNotNull('user_id')
      .select('user_id', 'ends_at')) as Array<{
      user_id: unknown
      ends_at: unknown
    }>
    for (const x of g) live.set(String(x.user_id).toUpperCase(), iso(x.ends_at))
  }
  const accounts = rows.slice(0, ROLE_HOLDERS_MAX).map((r): RoleHolder => {
    const name = [r.first_name, r.last_name]
      .filter((x) => typeof x === 'string' && x.trim())
      .join(' ')
    const id = String(r.id)
    return {
      user_id: id,
      name: name ? name.slice(0, 200) : null,
      email: clip(r.email, 320),
      entra_oid: clip(r.entra_oid, 64)?.toLowerCase() ?? null,
      role: clip(r.role_name, 200),
      admin: truthy(r.admin_access),
      status: String(r.status ?? '').slice(0, 32),
      kind: clip(r.account_kind, 32),
      last_access: iso(r.last_access),
      created_at: iso(r.created_at),
      break_glass_until: live.has(id.toUpperCase())
        ? (live.get(id.toUpperCase()) ?? 'unknown')
        : null
    }
  })
  accounts.sort(
    (a, b) =>
      Number(b.admin) - Number(a.admin) ||
      (b.last_access ?? '').localeCompare(a.last_access ?? '') ||
      a.user_id.localeCompare(b.user_id)
  )
  await logActivity({
    action: 'hub-access-review-read',
    user: null,
    collection: 'nivaro_users',
    comment: `The Nivaro Hub read who holds a role here for an access review: ${accounts.length} account(s)`,
    origin: 'integration'
  })
  return { accounts, total: accounts.length, truncated }
}

export type BreakGlassAnswer =
  | { ok: true; state: 'granted' | 'already_admin'; user_id: string; until: string | null }
  | { ok: false; status: 400 | 404 | 409; code: string; message: string }

const refused = (
  status: 400 | 404 | 409,
  code: string,
  message: string
): Extract<BreakGlassAnswer, { ok: false }> => ({ ok: false, status, code, message })

export interface GrantInput {
  ref: string
  hours: number
  until: number | null
  reason: string
  requestedBy: string | null
  approvedBy: string | null
  query: NonNullable<ReturnType<typeof readPeopleQuery>>
}

/** The body as a grant, or a refusal. Pure (now injectable). */
export function readGrant(
  body: unknown,
  now: number = Date.now()
): GrantInput | Extract<BreakGlassAnswer, { ok: false }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (typeof b.ref !== 'string' || !REF_RE.test(b.ref))
    return refused(400, 'BAD_REF', 'ref must be the Hub’s grant reference (bg-<id>)')
  const hours = Number(b.hours)
  if (!Number.isInteger(hours) || hours < 1 || hours > BREAK_GLASS_MAX_HOURS)
    return refused(400, 'BAD_HOURS', 'hours must be 1 to 24')
  let until: number | null = null
  if (b.until !== undefined && b.until !== null) {
    until = typeof b.until === 'string' ? Date.parse(b.until) : Number.NaN
    if (!Number.isFinite(until) || until <= now)
      return refused(400, 'BAD_UNTIL', 'until must be a time in the future')
  }
  const reason = clip(b.reason, 1000)
  if (!reason) return refused(400, 'BAD_REASON', 'Give the reason for the grant')
  const query = readPeopleQuery({ emails: b.emails, entra: b.entra })
  if (!query || query.user_ids.length)
    return refused(400, 'BAD_PERSON', 'Give up to 5 emails and/or Entra object ids')
  return {
    ref: b.ref,
    hours,
    until,
    reason,
    requestedBy: clip(b.requested_by, 200),
    approvedBy: clip(b.approved_by, 200),
    query
  }
}

/**
 * The strict identity rule for a grant (M3): an oid the Hub knows must be the account's own; no
 * oid on either side = the email match alone. Pure.
 */
export function identityAgrees(hubOids: string[], accountOid: string | null): boolean {
  const own = accountOid ? accountOid.toLowerCase() : null
  if (hubOids.length) return !!own && hubOids.includes(own)
  return !own
}

/** Grants temporary admin (see the header). Idempotent per ref while the grant holds. */
export async function grantBreakGlass(
  body: unknown,
  deps: { k?: Knex; now?: () => number } = {}
): Promise<BreakGlassAnswer> {
  const now = (deps.now ?? Date.now)()
  const input = readGrant(body, now)
  if ('ok' in input) return input
  const k = deps.k ?? db
  if (!(await grantsTableReady(k)))
    return refused(409, 'NOT_READY', 'This app has not run the migration that holds grants')
  const hasOid = await k.schema.hasColumn('nivaro_users', 'entra_oid')
  const { oldestAdminRoleQuery, withLockWait } = await import('./first-admin.js')
  let out: BreakGlassAnswer
  try {
    out = await k.transaction((trx) =>
      withLockWait(trx, async (): Promise<BreakGlassAnswer> => {
        const held = (await trx(GRANTS).where({ ref: input.ref }).first()) as
          | Record<string, unknown>
          | undefined
        if (held) {
          const g = grantFromRow(held)
          if (held.ended_at == null && !grantEnded(g, now) && g.user_id)
            return { ok: true, state: 'granted', user_id: g.user_id, until: g.ends_at }
          return refused(409, 'REF_ENDED', 'This grant was already revoked or ended; ask again')
        }
        const adminRole = (await oldestAdminRoleQuery(trx)) as { id: unknown } | undefined
        if (!adminRole) return refused(409, 'NO_ADMIN_ROLE', 'This app has no administrator role')
        const accounts = await matchPeople(input.query, trx)
        if (!accounts.length)
          return refused(404, 'NO_ACCOUNT', 'This person has no account in this app')
        if (accounts.length > 1)
          return refused(409, 'AMBIGUOUS', 'More than one account here matches this person')
        const a = accounts[0]
        const row = (await trx('nivaro_users')
          .where({ id: a.user_id })
          .first('id', 'role', 'status', ...(hasOid ? ['entra_oid'] : []))) as
          | Record<string, unknown>
          | undefined
        if (!row) return refused(404, 'NO_ACCOUNT', 'This person has no account in this app')
        const oid = typeof row.entra_oid === 'string' && row.entra_oid ? row.entra_oid : null
        if (
          !identityAgrees(
            input.query.entra.map((x) => x.oid),
            oid
          )
        )
          return refused(
            409,
            'IDENTITY_MISMATCH',
            'The account here is not proven to be this person (its Microsoft identity differs or is missing)'
          )
        if (String(row.status ?? '').toLowerCase() !== 'active')
          return refused(
            409,
            'ACCOUNT_NOT_ACTIVE',
            'The account here is not active; break-glass never reactivates an account'
          )
        const live = (await trx(GRANTS)
          .where({ user_id: row.id })
          .whereNull('ended_at')
          .first('id')) as { id: unknown } | undefined
        if (live)
          return refused(409, 'BREAK_GLASS_ACTIVE', 'Another break-glass grant holds this account')
        if (a.admin)
          return { ok: true, state: 'already_admin', user_id: String(row.id), until: null }
        const ends = grantEndsAt(input.hours, input.until, now)
        await trx(GRANTS).insert({
          ref: input.ref,
          user_id: row.id,
          role: adminRole.id,
          prev_role: row.role ?? null,
          reason: input.reason,
          requested_by: input.requestedBy,
          approved_by: input.approvedBy,
          granted_at: new Date(now),
          ends_at: ends
        })
        await trx('nivaro_users')
          .where({ id: row.id })
          .update({ role: adminRole.id, updated_at: new Date(now) })
        return { ok: true, state: 'granted', user_id: String(row.id), until: ends.toISOString() }
      })
    )
  } catch (err) {
    // A revoke's tombstone (or a twin grant) took the ref in the meantime: unique ref.
    if (await k(GRANTS).where({ ref: input.ref }).first('id'))
      out = refused(409, 'REF_ENDED', 'This grant was already revoked or ended; ask again')
    else throw err
  }
  if (out.ok && out.state === 'granted') {
    await logActivity({
      action: 'hub-break-glass-grant',
      user: null,
      collection: 'nivaro_users',
      item: out.user_id,
      comment:
        `Temporary administrator access from the Nivaro Hub (${input.ref}) until ${out.until}; asked by ${input.requestedBy ?? 'unknown'}, approved by ${input.approvedBy ?? 'unknown'}: ${input.reason}`.slice(
          0,
          1000
        ),
      origin: 'integration'
    })
  } else if (!out.ok && out.code === 'REF_ENDED') {
    await logActivity({
      action: 'hub-break-glass-late',
      user: null,
      collection: 'nivaro_users',
      comment: `A break-glass grant (${input.ref}) arrived after its revoke and was refused`,
      origin: 'integration'
    })
  }
  return out
}

export type RevokeState = 'revoked' | 'none' | 'role_changed' | 'restored_over_change'

export interface RevokeAnswer {
  ok: true
  state: RevokeState
  user_id?: string | null
  changed_by?: string | null
  changed_to?: string | null
  activity_count?: number | null
}

async function activityCount(k: Knex, userId: string, since: unknown): Promise<number | null> {
  try {
    const r = (await k('nivaro_activity')
      .where({ user: userId })
      .where('timestamp', '>=', since ?? new Date(0))
      .count<Array<{ n: number | string }>>({ n: '*' })) as Array<{ n: number | string }>
    return Number(r[0]?.n ?? 0)
  } catch {
    return null
  }
}

/**
 * The Hub's revoke: by ref (the account id or identity only confirms it). A ref no grant holds
 * leaves a tombstone (a late grant with it is refused). Idempotent: an ended grant answers what
 * its end recorded.
 */
export async function revokeBreakGlass(
  body: unknown,
  deps: { k?: Knex; now?: () => number } = {}
): Promise<RevokeAnswer | { ok: false; status: 400; code: string; message: string }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (typeof b.ref !== 'string' || !REF_RE.test(b.ref))
    return { ok: false, status: 400, code: 'BAD_REF', message: 'ref must be bg-<id>' }
  if (b.user_id !== undefined && (typeof b.user_id !== 'string' || !ID_RE.test(b.user_id)))
    return { ok: false, status: 400, code: 'BAD_USER', message: 'user_id must be an account id' }
  const k = deps.k ?? db
  if (!(await grantsTableReady(k))) return { ok: true, state: 'none' }
  const now = new Date((deps.now ?? Date.now)())
  const ref = b.ref
  const tombstone = async () => {
    try {
      await k(GRANTS).insert({
        ref,
        ended_at: now,
        end_reason: 'revoked_before_grant',
        end_state: 'none'
      })
      return true
    } catch {
      return false // the grant landed meanwhile (unique ref): end it below
    }
  }
  let row = (await k(GRANTS).where({ ref }).first()) as Record<string, unknown> | undefined
  if (!row) {
    if (await tombstone()) return { ok: true, state: 'none' }
    row = (await k(GRANTS).where({ ref }).first()) as Record<string, unknown> | undefined
    if (!row) return { ok: true, state: 'none' }
  }
  const end = await k.transaction((trx) => endGrantInTrx(trx, Number(row?.id), 'revoked', now))
  if (!end) return { ok: true, state: 'none' }
  if (row.ended_at == null && end.grant.user_id)
    await afterGrantEnded(end, 'revoked', 'revoked by the Hub')
  const state: RevokeState =
    end.state === 'restored' ? 'revoked' : end.state === 'none' ? 'none' : end.state
  return {
    ok: true,
    state,
    user_id: end.grant.user_id,
    changed_by: end.changed_by,
    changed_to: end.changed_to,
    activity_count: end.grant.user_id
      ? await activityCount(k, end.grant.user_id, row.granted_at)
      : null
  }
}

/** The app's own revoke (core job hub-break-glass-expire): see break-glass-grants.ts. */
export async function expireBreakGlass(
  deps: { k?: Knex; now?: () => number } = {}
): Promise<string[]> {
  return expireGrants(deps.k ?? db, new Date((deps.now ?? Date.now)()))
}
