import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { type BreakGlassMark, readBreakGlassMark } from '../break-glass-role.js'
import { matchPeople, readPeopleQuery } from './people.js'

/**
 * Hub link (app side, 0.3.215+): what the Nivaro Hub's security features ask of an app.
 *
 *   GET  security/role-holders   → {version, accounts, total, truncated}   access reviews (41)
 *   POST security/break-glass    {ref, emails?, entra?, until, reason}      temporary admin (45)
 *                                → {state: granted | already_admin, user_id, until}
 *   POST security/break-glass/revoke {ref, user_id} → {state: revoked | none | role_changed}
 *
 * Mounted inside the hub link (`/api/hub-link/security/*`, a dedicated app) and the deployment
 * link (`/api/hub-deployment/apps/:id/security/*`, one app of a shared deployment), each behind
 * that link's bearer check; exempt from the maintenance freeze and the retire gate like every
 * link call (a revoke must never wait for a freeze).
 *
 * Role holders: every account with a role, people and service accounts alike (a review must see
 * an admin service account too), newest-active first, admins first, at most ROLE_HOLDERS_MAX.
 * Directory facts only (id, name, email, role name, admin flag, status, kind, last sign-in) —
 * never a password, token, preference or record. The read is logged in the app.
 *
 * Break-glass: the person is matched as the people routes match (email or Entra object id, people
 * accounts only); exactly one account, and it must be active — a grant never creates, reactivates
 * or un-suspends an account. The account's role becomes the app's oldest admin role and the mark
 * `nivaro_users.break_glass` keeps the expiry and the role it had, so the app puts it back by
 * itself when the grant ends (expireBreakGlass, every minute; and every request judges it:
 * services/break-glass-role.ts). The swap runs in one transaction under the admin role lock
 * (first-admin.ts). A grant is at most BREAK_GLASS_MAX_MS long, whatever the Hub asks.
 */

export const ROLE_HOLDERS_MAX = 5000
export const BREAK_GLASS_MAX_MS = 25 * 3_600_000
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
  role: string | null
  admin: boolean
  status: string
  kind: string | null
  last_access: string | null
  created_at: string | null
  break_glass_until: string | null
}

/** Every account with a role (see the header). */
export async function listRoleHolders(
  k: Knex = db
): Promise<{ accounts: RoleHolder[]; total: number; truncated: boolean }> {
  const hasBg = await k.schema.hasColumn('nivaro_users', 'break_glass')
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
      ...(hasBg ? ['u.break_glass'] : []),
      'r.name as role_name',
      'r.admin_access as admin_access'
    )
    .limit(ROLE_HOLDERS_MAX + 1)) as Array<Record<string, unknown>>
  const truncated = rows.length > ROLE_HOLDERS_MAX
  const accounts = rows.slice(0, ROLE_HOLDERS_MAX).map((r): RoleHolder => {
    const name = [r.first_name, r.last_name]
      .filter((x) => typeof x === 'string' && x.trim())
      .join(' ')
    const mark = hasBg ? readBreakGlassMark(r.break_glass) : null
    return {
      user_id: String(r.id),
      name: name ? name.slice(0, 200) : null,
      email: clip(r.email, 320),
      role: clip(r.role_name, 200),
      admin: truthy(r.admin_access),
      status: String(r.status ?? '').slice(0, 32),
      kind: clip(r.account_kind, 32),
      last_access: iso(r.last_access),
      created_at: iso(r.created_at),
      break_glass_until: mark ? mark.until : null
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
  until: Date
  reason: string
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
  const until = typeof b.until === 'string' ? Date.parse(b.until) : Number.NaN
  if (!Number.isFinite(until) || until <= now)
    return refused(400, 'BAD_UNTIL', 'until must be a time in the future')
  if (until - now > BREAK_GLASS_MAX_MS)
    return refused(400, 'TOO_LONG', 'A break-glass grant lasts at most 24 hours')
  const reason = clip(b.reason, 1000)
  if (!reason) return refused(400, 'BAD_REASON', 'Give the reason for the grant')
  const query = readPeopleQuery({ emails: b.emails, entra: b.entra })
  if (!query) return refused(400, 'BAD_PERSON', 'Give up to 5 emails and/or Entra object ids')
  return { ref: b.ref, until: new Date(until), reason, query }
}

/**
 * Grants temporary admin (see the header). Idempotent per ref: asking again for the same ref
 * answers the grant that holds. Another grant holding the account → 409 BREAK_GLASS_ACTIVE.
 */
export async function grantBreakGlass(
  body: unknown,
  deps: { k?: Knex; now?: () => number } = {}
): Promise<BreakGlassAnswer> {
  const now = (deps.now ?? Date.now)()
  const input = readGrant(body, now)
  if ('ok' in input) return input
  const k = deps.k ?? db
  if (!(await k.schema.hasColumn('nivaro_users', 'break_glass')))
    return refused(409, 'NOT_READY', 'This app has not run the migration that holds grants')
  const { oldestAdminRoleQuery, withLockWait } = await import('./first-admin.js')
  const out = await k.transaction((trx) =>
    withLockWait(trx, async (): Promise<BreakGlassAnswer> => {
      const adminRole = (await oldestAdminRoleQuery(trx)) as { id: unknown } | undefined
      if (!adminRole) return refused(409, 'NO_ADMIN_ROLE', 'This app has no administrator role')
      const accounts = await matchPeople(input.query, trx)
      if (!accounts.length)
        return refused(404, 'NO_ACCOUNT', 'This person has no account in this app')
      if (accounts.length > 1)
        return refused(409, 'AMBIGUOUS', 'More than one account here matches this person')
      const a = accounts[0]
      if (a.status.toLowerCase() !== 'active')
        return refused(
          409,
          'ACCOUNT_NOT_ACTIVE',
          'The account here is not active; break-glass never reactivates an account'
        )
      const row = (await trx('nivaro_users')
        .where({ id: a.user_id })
        .first('id', 'role', 'break_glass')) as
        | { id: unknown; role: unknown; break_glass: unknown }
        | undefined
      if (!row) return refused(404, 'NO_ACCOUNT', 'This person has no account in this app')
      const held = readBreakGlassMark(row.break_glass)
      if (held && Date.parse(held.until) > now) {
        if (held.ref === input.ref)
          return { ok: true, state: 'granted', user_id: String(row.id), until: held.until }
        return refused(409, 'BREAK_GLASS_ACTIVE', 'Another break-glass grant holds this account')
      }
      if (a.admin && !held)
        return { ok: true, state: 'already_admin', user_id: String(row.id), until: null }
      // A finished mark that was never cleared: its role goes back first (expireOne's rule).
      const prevRole =
        held && String(row.role ?? '').toUpperCase() === held.role.toUpperCase()
          ? held.prev_role
          : row.role == null
            ? null
            : String(row.role)
      const mark: BreakGlassMark = {
        ref: input.ref,
        until: input.until.toISOString(),
        role: String(adminRole.id),
        prev_role: prevRole,
        at: new Date(now).toISOString()
      }
      await trx('nivaro_users')
        .where({ id: row.id })
        .update({ role: mark.role, break_glass: JSON.stringify(mark), updated_at: new Date(now) })
      return { ok: true, state: 'granted', user_id: String(row.id), until: mark.until }
    })
  )
  if (out.ok && out.state === 'granted') {
    await logActivity({
      action: 'hub-break-glass-grant',
      user: null,
      collection: 'nivaro_users',
      item: out.user_id,
      comment:
        `Temporary administrator access from the Nivaro Hub (${input.ref}) until ${out.until}: ${input.reason}`.slice(
          0,
          1000
        ),
      origin: 'integration'
    })
  }
  return out
}

type RevokeState = 'revoked' | 'none' | 'role_changed'

/** Puts one account's role back (inside a transaction). Never touches another grant's mark. */
async function revokeRow(
  trx: Knex.Transaction,
  userId: string,
  ref: string | null,
  now: number
): Promise<{ state: RevokeState; mark: BreakGlassMark | null }> {
  const row = (await trx('nivaro_users')
    .where({ id: userId })
    .first('id', 'role', 'break_glass')) as
    | { id: unknown; role: unknown; break_glass: unknown }
    | undefined
  const mark = row ? readBreakGlassMark(row.break_glass) : null
  if (!row || !mark || (ref && mark.ref !== ref)) return { state: 'none', mark: null }
  const still = String(row.role ?? '').toUpperCase() === mark.role.toUpperCase()
  await trx('nivaro_users')
    .where({ id: row.id })
    .update({
      ...(still ? { role: mark.prev_role } : {}),
      break_glass: null,
      updated_at: new Date(now)
    })
  return { state: still ? 'revoked' : 'role_changed', mark }
}

async function logRevoke(userId: string, mark: BreakGlassMark, state: RevokeState, why: string) {
  await logActivity({
    action: 'hub-break-glass-revoke',
    user: null,
    collection: 'nivaro_users',
    item: userId,
    comment:
      state === 'role_changed'
        ? `Break-glass ${mark.ref} ended (${why}); the role was changed during the grant and stays as it is`
        : `Break-glass ${mark.ref} ended (${why}); the role it replaced is back`,
    origin: 'integration'
  })
}

/**
 * The Hub's revoke: {ref, user_id} — or {ref, emails?, entra?} when the Hub never learned the
 * account id (a grant whose answer was lost). Only a mark with that ref is ever touched.
 * Idempotent (an ended grant answers `none`).
 */
export async function revokeBreakGlass(
  body: unknown,
  deps: { k?: Knex; now?: () => number } = {}
): Promise<
  { ok: true; state: RevokeState } | { ok: false; status: 400; code: string; message: string }
> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (typeof b.ref !== 'string' || !REF_RE.test(b.ref))
    return { ok: false, status: 400, code: 'BAD_REF', message: 'ref must be bg-<id>' }
  const ref = b.ref
  const k = deps.k ?? db
  let ids: string[]
  if (b.user_id !== undefined) {
    if (typeof b.user_id !== 'string' || !ID_RE.test(b.user_id))
      return { ok: false, status: 400, code: 'BAD_USER', message: 'user_id must be an account id' }
    ids = [b.user_id]
  } else {
    const q = readPeopleQuery({ emails: b.emails, entra: b.entra })
    if (!q)
      return {
        ok: false,
        status: 400,
        code: 'BAD_PERSON',
        message: 'Give user_id, or emails / entra'
      }
    ids = (await matchPeople(q, k)).map((a) => a.user_id)
  }
  if (!(await k.schema.hasColumn('nivaro_users', 'break_glass'))) return { ok: true, state: 'none' }
  const now = (deps.now ?? Date.now)()
  let state: RevokeState = 'none'
  for (const userId of ids) {
    const out = await k.transaction((trx) => revokeRow(trx, userId, ref, now))
    if (out.mark) {
      await logRevoke(userId, out.mark, out.state, 'revoked by the Hub')
      state = out.state
    }
  }
  return { ok: true, state }
}

/**
 * The app's own revoke (job hub-break-glass-expire, every minute; per app on a shared
 * deployment): every mark whose `until` has passed. Answers the account ids put back.
 */
export async function expireBreakGlass(
  deps: { k?: Knex; now?: () => number } = {}
): Promise<string[]> {
  const k = deps.k ?? db
  if (!(await k.schema.hasColumn('nivaro_users', 'break_glass'))) return []
  const now = (deps.now ?? Date.now)()
  const rows = (await k('nivaro_users')
    .whereNotNull('break_glass')
    .select('id', 'break_glass')
    .limit(500)) as Array<{ id: unknown; break_glass: unknown }>
  const done: string[] = []
  for (const r of rows) {
    const mark = readBreakGlassMark(r.break_glass)
    const id = String(r.id)
    if (mark && Date.parse(mark.until) > now) continue
    if (!mark) {
      // Unreadable: nothing to put back, but it must not linger.
      await k('nivaro_users').where({ id: r.id }).update({ break_glass: null })
      continue
    }
    const out = await k.transaction((trx) => revokeRow(trx, id, mark.ref, now))
    if (out.mark) {
      await logRevoke(id, out.mark, out.state, 'its time ran out')
      done.push(id)
    }
  }
  return done
}
