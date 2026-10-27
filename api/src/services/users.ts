import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { stripAiMemory } from './ai-memory.js'
import { chainFields } from './chain-columns.js'
import { getApp } from './io-holder.js'
import { resolveRoleFromAdGroups } from './microsoft.js'
import { notificationRowMeta, notifyUser } from './notification-channels.js'
import { queueOfficeGeocode } from './office-geocode.js'
import { orderByPeopleRelevance } from './people-search-rank.js'
import { DIRECTORY_USER_COLS } from './user-directory-cols.js'

/** Credentials and identity-provider links that never leave the server on a user's own row. */
export const USER_CREDENTIAL_FIELDS = [
  'static_token',
  'password_hash',
  'totp_secret',
  'external_id'
] as const

/**
 * A user row as the API answers it about a person (security audit H6): no static token,
 * password hash, TOTP secret or IdP subject. A token in a response survives sign-out and is one
 * XSS away from theft, a narrow API key must not read its owner's full token, and a View-as
 * admin must not receive the target's hash. `has_static_token` says whether a token exists;
 * clients that used it for sockets mint a one-time ws token instead.
 */
export function withoutCredentials<T extends Record<string, unknown>>(
  user: T
): Omit<T, (typeof USER_CREDENTIAL_FIELDS)[number]> & { has_static_token: boolean } {
  const out: Record<string, unknown> = { ...user }
  for (const f of USER_CREDENTIAL_FIELDS) delete out[f]
  out.has_static_token = !!user.static_token
  return out as Omit<T, (typeof USER_CREDENTIAL_FIELDS)[number]> & { has_static_token: boolean }
}

/** A sign-in whose identity may not be linked to the account its email names (H7). */
export class AccountLinkRefusedError extends Error {
  readonly code = 'ACCOUNT_LINK_REFUSED'
}

function sameEmail(a: unknown, b: unknown): boolean {
  const x = String(a ?? '')
    .trim()
    .toLowerCase()
  return (
    !!x &&
    x ===
      String(b ?? '')
        .trim()
        .toLowerCase()
  )
}

/**
 * The subject an ADDITIONAL sign-in provider (Settings → Sign-in providers) is stored under:
 * `oidc:<issuer>|<sub>`, so two issuers that hand out the same subject string can never be the
 * same account. The primary env-configured provider keeps the raw `sub` (every existing account
 * keeps matching); SAML already stores `saml:<nameID>`.
 */
export function namespacedSub(issuer: string, sub: string): string {
  return `oidc:${String(issuer).trim().replace(/\/+$/, '')}|${sub}`
}

/** Only an active, non-redacted account may hold a session. */
export function canSignIn(user: Pick<User, 'status'> & { is_redacted?: unknown }): boolean {
  return user.status === 'active' && !user.is_redacted
}

/**
 * Store the Entra object id + tenant id on a user (Teams bot, spec §4).
 * 'same' = already stored; 'conflict' = the user holds a different oid, or
 * another user holds this one: nothing is written.
 */
export async function recordEntraIdentity(
  userId: string,
  rawOid: string,
  rawTid: string
): Promise<'stored' | 'same' | 'conflict'> {
  // Stored lowercased so lookups compare with plain equality (the filtered unique index on
  // entra_oid serves them); the Teams side lowercases the incoming aadObjectId the same way.
  const oid = String(rawOid).trim().toLowerCase()
  const tid = String(rawTid).trim().toLowerCase()
  const row = (await db('nivaro_users').where({ id: userId }).first('entra_oid', 'entra_tid')) as
    | { entra_oid?: string | null; entra_tid?: string | null }
    | undefined
  if (row?.entra_oid) {
    if (row.entra_oid.toLowerCase() === oid.toLowerCase()) return 'same'
    console.warn(`[entra-oid] refused: user ${userId} already holds a different object id`)
    return 'conflict'
  }
  const other = await db('nivaro_users')
    .where({ entra_oid: oid })
    .whereNot({ id: userId })
    .first('id')
  if (other) {
    console.warn(`[entra-oid] refused: object id already held by another user (${userId})`)
    return 'conflict'
  }
  await db('nivaro_users').where({ id: userId }).update({ entra_oid: oid, entra_tid: tid })
  return 'stored'
}

/** Sign-in hook: never blocks the sign-in; a conflict leaves an activity row. Exported for tests. */
export async function captureEntraIdentity(
  userId: string,
  profile: { entraOid?: string | null; entraTid?: string | null }
): Promise<void> {
  if (!profile.entraOid || !profile.entraTid) return
  try {
    const out = await recordEntraIdentity(userId, profile.entraOid, profile.entraTid)
    if (out === 'conflict') {
      const { logActivity } = await import('./activity.js')
      await logActivity({
        action: 'entra-oid-conflict',
        user: userId,
        collection: 'nivaro_users',
        item: userId,
        comment: 'Sign-in carried an Entra object id that does not match the stored one'
      })
    }
  } catch (err) {
    // Column missing (behind migration 505) or transient: sign-in proceeds. Never log the oid.
    // SQL Server's duplicate-key message quotes the key value, so the oid is scrubbed out.
    const e = err as { code?: unknown; number?: unknown; message?: unknown }
    const oid = String(profile.entraOid).trim()
    const msg = String(e?.message ?? err)
      .replace(new RegExp(oid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<oid>')
      .replace(/duplicate key value is \([^)]*\)/gi, 'duplicate key value is (<redacted>)')
      .slice(0, 200)
    console.warn(
      `[entra-oid] could not record the Entra identity for user ${userId}: ${String(e?.code ?? e?.number ?? '')} ${msg}`
    )
  }
}

export async function findOrCreateFromOIDC(profile: {
  sub: string
  email: string
  given_name: string | null
  family_name: string | null
  groups?: string[] // Azure AD group IDs from OIDC claims
  // Org fields from Microsoft Graph (jobTitle/companyName/department/phone).
  // IdP is source of truth: overwritten on every login when present, same as names.
  title?: string | null
  company?: string | null
  department?: string | null
  phone?: string | null
  office_location?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  employee_id?: string | null
  preferred_language?: string | null
  avatar?: string | null
  // Entra object + tenant id from the ID token (Microsoft issuers only).
  entraOid?: string | null
  entraTid?: string | null
  /** An additional provider's RAW subject, when `sub` is issuer-namespaced (namespacedSub):
   *  accounts it linked before namespacing still match, and are re-stamped namespaced. */
  legacySub?: string | null
}): Promise<User> {
  if (!profile.sub) throw new AccountLinkRefusedError('The identity provider sent no subject')
  // Match by the immutable subject first; email only links a pre-provisioned
  // user on their FIRST login (external_id gets stamped immediately below,
  // so subsequent logins always hit the sub match).
  let existing = await db<User>('nivaro_users').where({ external_id: profile.sub }).first()
  if (!existing && profile.legacySub && profile.email) {
    // Linked by this provider before subjects were namespaced: the raw subject AND the email
    // must both match, so another issuer reusing a subject string cannot claim it.
    const legacy = (await db<User>('nivaro_users')
      .where({ external_id: profile.legacySub })
      .first()) as User | undefined
    if (legacy && sameEmail(legacy.email, profile.email)) existing = legacy
  }
  if (!existing && profile.email) {
    // Security audit H7: email links ONLY an account no identity has claimed yet (a
    // pre-provisioned row). An account already bound to another subject is never taken over
    // by an email claim — a custom IdP, or a mailbox someone renamed, could assert any email.
    const byEmail = (await db<User>('nivaro_users').where({ email: profile.email }).first()) as
      | (User & { external_id?: string | null })
      | undefined
    if (byEmail) {
      if (byEmail.external_id) {
        console.warn(
          `[oidc] refused: email matches user ${byEmail.id}, which is linked to another sign-in identity`
        )
        throw new AccountLinkRefusedError(
          'This email belongs to an account linked to a different sign-in. Ask an administrator.'
        )
      }
      existing = byEmail
    }
  }

  const adRole = await resolveRoleFromAdGroups(profile.groups ?? [])

  // A suspended or redacted account is handed back untouched: the callback
  // refuses the sign-in, and the attempt must not refresh the row.
  if (existing && !canSignIn(existing)) return existing

  if (existing) {
    const updates: Record<string, unknown> = {
      external_id: profile.sub,
      last_access: new Date(),
      updated_at: new Date()
    }
    if (profile.given_name) updates.first_name = profile.given_name
    if (profile.family_name) updates.last_name = profile.family_name
    if (profile.title) updates.title = profile.title
    if (profile.company) updates.company = profile.company
    if (profile.department) updates.department = profile.department
    if (profile.phone) updates.phone = profile.phone
    if (profile.office_location) updates.office_location = profile.office_location
    if (profile.city) updates.city = profile.city
    if (profile.state) updates.state = profile.state
    if (profile.country) updates.country = profile.country
    if (profile.employee_id) updates.employee_id = profile.employee_id
    if (profile.preferred_language) updates.preferred_language = profile.preferred_language
    if (profile.avatar) {
      updates.avatar = profile.avatar
      updates.avatar_updated_at = new Date()
    }
    if (adRole) updates.role = adRole
    await db('nivaro_users').where({ id: existing.id }).update(updates)
    if (profile.office_location) queueOfficeGeocode(existing.id)
    await captureEntraIdentity(existing.id, profile)
    return {
      ...existing,
      ...updates,
      external_id: profile.sub,
      first_name: (profile.given_name ?? existing.first_name) as string,
      last_name: (profile.family_name ?? existing.last_name) as string,
      role: adRole ?? existing.role
    }
  }

  // Assign role: AD group mapping first, then the instance's configured
  // provisional role (nivaro_settings.new_user_role — the "awaiting
  // authorization" seat a self-service sign-up starts in), then the first
  // non-admin app role as the historic fallback.
  let assignedRole: string | null = adRole
  if (!assignedRole) assignedRole = await configuredNewUserRole()
  if (!assignedRole) {
    const defaultRole = await db('nivaro_roles')
      .where({ admin_access: false, app_access: true })
      .orderBy('name')
      .first()
    assignedRole = defaultRole?.id ?? null
  }

  const [id] = (await db('nivaro_users')
    .insert({
      email: profile.email,
      first_name: profile.given_name,
      last_name: profile.family_name,
      title: profile.title ?? null,
      company: profile.company ?? null,
      department: profile.department ?? null,
      phone: profile.phone ?? null,
      office_location: profile.office_location ?? null,
      city: profile.city ?? null,
      state: profile.state ?? null,
      country: profile.country ?? null,
      employee_id: profile.employee_id ?? null,
      preferred_language: profile.preferred_language ?? null,
      avatar: profile.avatar ?? null,
      avatar_updated_at: profile.avatar ? new Date() : null,
      external_id: profile.sub,
      role: assignedRole,
      status: 'active',
      last_access: new Date()
    })
    .returning('id')) as unknown as [string]

  // Welcome auto-broadcast (#389): a configured message greets brand-new
  // users on first login — in-app row, fire-and-forget.
  const newId = typeof id === 'object' ? (id as { id?: string }).id : id
  if (newId) await captureEntraIdentity(newId, profile)
  if (newId && profile.office_location) queueOfficeGeocode(newId)
  if (newId) {
    void db('nivaro_settings')
      .first('welcome_message')
      .then(async (settings) => {
        const msg = (settings as { welcome_message?: string | null } | undefined)?.welcome_message
        if (!msg?.trim()) return
        const app = getApp()
        if (app) {
          // Through notifyUser (#782): a brand-new account has no rules yet,
          // so this always lands; the target is the home page.
          await notifyUser(app, newId, {
            subject: 'Welcome!',
            message: msg.trim().slice(0, 500),
            category: 'system',
            always_inbox: true,
            target: { kind: 'home', action: 'open' },
            source: { kind: 'welcome', label: 'Welcome message' },
            why: 'This is the welcome message every new account receives once.'
          })
          return
        }
        await db('nivaro_notifications').insert({
          ...(await chainFields('nivaro_notifications')),
          recipient: newId,
          subject: 'Welcome!',
          status: 'inbox',
          timestamp: new Date(),
          sender: null,
          message: msg.trim().slice(0, 500),
          ...notificationRowMeta({ subject: 'Welcome!', category: 'system' })
        })
      })
      .catch(() => {})
  }

  // `.returning('id')` hands back an OBJECT on mssql — reading with the raw
  // value 500'd every first sign-in ("Validation failed for parameter p1").
  return db<User>('nivaro_users').where({ id: newId }).first() as Promise<User>
}

/** nivaro_settings.new_user_role when it names a live, non-admin role. */
async function configuredNewUserRole(): Promise<string | null> {
  const settings = (await db('nivaro_settings')
    .first('new_user_role')
    .catch(() => null)) as { new_user_role?: string | null } | null
  const roleId = settings?.new_user_role
  if (!roleId) return null
  const role = await db('nivaro_roles').where({ id: roleId }).first('id', 'admin_access')
  if (!role || role.admin_access) return null
  return String(role.id)
}

export async function getUser(id: string): Promise<User | undefined> {
  // nivaro_users.id is a uniqueidentifier: anything else is nobody, not a
  // conversion error from SQL Server.
  if (!USER_ID_SHAPE.test(String(id ?? ''))) return undefined
  const row = await db<User>('nivaro_users').where({ id }).first()
  return row ? parsePreferences(row) : row
}

const USER_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const USER_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'title',
  'company',
  'department',
  'phone',
  'office_location',
  'city',
  'state',
  'country',
  'employee_id',
  'role',
  'status',
  'last_access',
  'preferences',
  'manager_id',
  'delegate_id',
  'delegate_expires_at',
  'ooo_start',
  'ooo_end',
  'is_out_of_office',
  'created_at',
  'directory_status',
  'directory_checked_at',
  'account_kind'
] as const

// preferences is nvarchar JSON — parse on read, stringify on write so callers
// always see an object (or null)
function parsePreferences<T extends { preferences?: unknown }>(row: T): T {
  if (row && typeof row.preferences === 'string') {
    try {
      row.preferences = JSON.parse(row.preferences)
    } catch {
      row.preferences = null
    }
  }
  return row
}

const FILTERABLE_USER_COLS = new Set<string>(USER_COLS.filter((c) => c !== 'preferences'))

const SORTABLE_USER_COLS = new Set<string>([
  'first_name',
  'last_name',
  'email',
  'role',
  'status',
  'last_access',
  'created_at'
])

export async function listUsers(
  opts: {
    limit?: number
    offset?: number
    search?: string
    sort?: string
    filter?: Record<string, unknown>
    /** Reduced, non-admin-safe projection (see DIRECTORY_USER_COLS). */
    directory?: boolean
    /** Management surfaces only — pickers must never see suspended users. */
    includeSuspended?: boolean
    /** Admin audit view: ONLY the accounts every other listing hides
     *  (redacted flag, anonymised 'Redacted_…' emails, 'legacy-…' import
     *  placeholders). Suspended rows ride along — most hidden rows are. */
    hiddenOnly?: boolean
    /** People only — drop integration/bot/service/placeholder accounts even
     *  from an admin's listing (assignee pickers). The directory always does. */
    peopleOnly?: boolean
    /** Column subset (intersected with the caller's projection; id always
     *  rides). A banner that needs three columns of 500 users should not
     *  pull 300 KB of the full projection. */
    fields?: string[]
  } = {}
) {
  const {
    limit = 25,
    offset = 0,
    search,
    sort,
    filter,
    directory,
    includeSuspended,
    hiddenOnly,
    peopleOnly,
    fields
  } = opts

  // Suspended users are excluded by default so every dropdown reading this
  // endpoint inherits the filter (same pattern as is_redacted). Existing
  // references still display — single-user reads don't go through here.
  const applySuspendedFilter = (qb: Knex.QueryBuilder) => {
    // The person directory is for picking PEOPLE: an integration identity or a
    // placeholder is never a valid assignee, contact or mention. Admin listings
    // keep them (that is where they are managed).
    if (directory || peopleOnly) qb.whereNull('account_kind')
    if (includeSuspended || hiddenOnly) return
    qb.where((inner) => {
      inner.where('status', '!=', 'suspended').orWhereNull('status')
    })
  }

  const applyConditions = (qb: Knex.QueryBuilder) => {
    if (search) {
      // AND across whitespace-separated terms, OR across columns, so a full
      // name ("Jane Doe") matches — a single %Jane Doe% never hits any one
      // column and made every multi-word search return nothing.
      for (const term of search.trim().split(/\s+/)) {
        qb.where((inner) => {
          inner
            .orWhere('first_name', 'like', `%${term}%`)
            .orWhere('last_name', 'like', `%${term}%`)
            .orWhere('email', 'like', `%${term}%`)
        })
      }
    }
    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        // Listed columns only: an unknown name was a 500 with the driver's
        // text, and a credential column (static_token) must never be
        // probe-able through a filter — admins included.
        if (!FILTERABLE_USER_COLS.has(key)) continue
        if (typeof value === 'object' && value !== null) {
          for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
            if (op === '_eq') qb.where(key, '=', val as string)
            else if (op === '_neq') qb.where(key, '!=', val as string)
            else if (op === '_in' && Array.isArray(val)) qb.whereIn(key, val as string[])
            else if (op === '_nin' && Array.isArray(val)) qb.whereNotIn(key, val as string[])
          }
        } else {
          qb.where(key, '=', value as string)
        }
      }
    }
  }

  // Hidden accounts: rows flagged is_redacted, plus rows the anonymiser
  // scrubbed by email only ('Redacted_…') and legacy import placeholders
  // ('legacy-…') whose flag was never set. Legacy clients used to hide the
  // email-prefix rows per page, which blanked whole pages and inflated the
  // page count because the server still returned and counted them.
  const applyHiddenAccountFilter = (qb: Knex.QueryBuilder) => {
    if (hiddenOnly) {
      qb.where((inner) => {
        inner
          .where('is_redacted', true)
          .orWhereRaw(`email like 'legacy-%'`)
          .orWhereRaw(`email like 'Redacted\\_%' escape '\\'`)
      })
      return
    }
    qb.where('is_redacted', false)
      .whereRaw(`email not like 'legacy-%'`)
      .whereRaw(`email not like 'Redacted\\_%' escape '\\'`)
  }

  // Directory rows also SELECT preferences — but only to derive `timezone`
  // (#175 local-time chips); the raw blob is stripped before the response so
  // the withheld column still never leaves the server.
  const projection: readonly string[] = directory ? DIRECTORY_USER_COLS : USER_COLS
  const narrowed =
    fields && fields.length > 0
      ? ['id', ...projection.filter((c) => c !== 'id' && fields.includes(c))]
      : [...projection]
  const listQ = db<User>('nivaro_users').select(
    directory
      ? [...narrowed, 'preferences']
      : hiddenOnly
        ? [...narrowed, 'is_redacted', 'redacted_at']
        : narrowed
  )
  applyHiddenAccountFilter(listQ)
  applySuspendedFilter(listQ)
  // Directory callers get search + sort only: an arbitrary caller-supplied
  // filter could probe columns the projection deliberately withholds.
  if (!directory) applyConditions(listQ)
  else if (search) applyConditions(listQ)

  if (sort) {
    const col = sort.startsWith('-') ? sort.slice(1) : sort
    const dir = sort.startsWith('-') ? 'desc' : 'asc'
    listQ.orderBy(SORTABLE_USER_COLS.has(col) ? col : 'created_at', dir)
  } else if (!orderByPeopleRelevance(listQ, search)) {
    // A search ranks by name (services/people-search-rank.ts); the plain list stays newest first.
    listQ.orderBy('created_at', 'desc')
  }

  const countQ = db('nivaro_users').count('id as count')
  applyHiddenAccountFilter(countQ)
  applySuspendedFilter(countQ)
  if (!directory) applyConditions(countQ)
  else if (search) applyConditions(countQ)

  const [users, [{ count }]] = await Promise.all([listQ.limit(limit).offset(offset), countQ])
  const rows = users as unknown as User[]
  return {
    data: directory
      ? rows.map((u) => {
          const r = u as User & { preferences?: unknown; timezone?: string | null }
          let tz: string | null = null
          try {
            const prefs =
              typeof r.preferences === 'string' ? JSON.parse(r.preferences) : r.preferences
            if (prefs && typeof prefs === 'object') {
              const v = (prefs as { timezone?: unknown }).timezone
              if (typeof v === 'string' && v) tz = v
            }
          } catch {
            /* corrupt prefs — no timezone */
          }
          ;(r as unknown as Record<string, unknown>).preferences = undefined
          delete (r as unknown as Record<string, unknown>).preferences
          r.timezone = tz
          return r
        })
      : rows.map((u) => {
          // #1804 — a list never carries anyone's Ask AI memory.
          const r = stripAiMemory(parsePreferences(u))
          if (hiddenOnly) (r as unknown as Record<string, unknown>).hidden_kind = hiddenKindOf(r)
          return r
        }),
    total: Number(count)
  }
}

/** Why an account is left out of every ordinary listing. */
function hiddenKindOf(u: {
  email?: string | null
  is_redacted?: unknown
}): 'redacted' | 'anonymised' | 'placeholder' {
  const email = String(u.email ?? '')
  if (/^legacy-/i.test(email)) return 'placeholder'
  if (u.is_redacted === true || u.is_redacted === 1) return 'redacted'
  return 'anonymised'
}

export async function updateUser(
  id: string,
  data: Partial<
    Pick<
      User,
      | 'first_name'
      | 'last_name'
      | 'status'
      | 'role'
      | 'last_page'
      | 'preferences'
      | 'manager_id'
      | 'delegate_id'
      | 'delegate_expires_at'
      | 'is_out_of_office'
      | 'account_kind'
    >
  >
) {
  const updates: Record<string, unknown> = { ...data, updated_at: new Date() }
  if (updates.preferences && typeof updates.preferences === 'object') {
    updates.preferences = JSON.stringify(updates.preferences)
  }
  await db('nivaro_users').where({ id }).update(updates)
  return getUser(id)
}

export async function updateLastPage(id: string, path: string) {
  await db('nivaro_users').where({ id }).update({ last_page: path, updated_at: new Date() })
}
