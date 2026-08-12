import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { resolveRoleFromAdGroups } from './microsoft.js'

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
}): Promise<User> {
  // Match by the immutable subject first; email only links a pre-provisioned
  // user on their FIRST login (external_id gets stamped immediately below,
  // so subsequent logins always hit the sub match).
  let existing = await db<User>('nivaro_users').where({ external_id: profile.sub }).first()
  if (!existing && profile.email) {
    existing = await db<User>('nivaro_users').where({ email: profile.email }).first()
  }

  const adRole = await resolveRoleFromAdGroups(profile.groups ?? [])

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
    if (adRole) updates.role = adRole
    await db('nivaro_users').where({ id: existing.id }).update(updates)
    return {
      ...existing,
      ...updates,
      external_id: profile.sub,
      first_name: (profile.given_name ?? existing.first_name) as string,
      last_name: (profile.family_name ?? existing.last_name) as string,
      role: adRole ?? existing.role
    }
  }

  // Assign role: AD group mapping takes priority, then first non-admin role
  let assignedRole: string | null = adRole
  if (!assignedRole) {
    const defaultRole = await db('nivaro_roles')
      .where({ admin_access: false, app_access: true })
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
      external_id: profile.sub,
      role: assignedRole,
      status: 'active',
      last_access: new Date()
    })
    .returning('id')) as unknown as [string]

  return db<User>('nivaro_users').where({ id }).first() as Promise<User>
}

export async function getUser(id: string): Promise<User | undefined> {
  const row = await db<User>('nivaro_users').where({ id }).first()
  return row ? parsePreferences(row) : row
}

const USER_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'title',
  'company',
  'department',
  'phone',
  'role',
  'status',
  'last_access',
  'preferences',
  'manager_id',
  'delegate_id',
  'delegate_expires_at',
  'is_out_of_office',
  'created_at'
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
/**
 * What a NON-ADMIN may see of another user. The assignee/mention pickers that
 * every record form renders need a person directory, but the full USER_COLS set
 * carries `preferences` (efp-new stores access-request notes there), phone, and
 * the manager/delegate graph — none of which belong in a picker payload.
 */
const DIRECTORY_USER_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'title',
  'department',
  'company',
  'status'
] as const

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
  } = {}
) {
  const { limit = 25, offset = 0, search, sort, filter, directory, includeSuspended } = opts

  // Suspended users are excluded by default so every dropdown reading this
  // endpoint inherits the filter (same pattern as is_redacted). Existing
  // references still display — single-user reads don't go through here.
  const applySuspendedFilter = (qb: Knex.QueryBuilder) => {
    if (includeSuspended) return
    qb.where((inner) => {
      inner.where('status', '!=', 'suspended').orWhereNull('status')
    })
  }

  const applyConditions = (qb: Knex.QueryBuilder) => {
    if (search) {
      // AND across whitespace-separated terms, OR across columns, so a full
      // name ("Rob Lee") matches — a single %Rob Lee% never hits any one
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
        if (typeof value === 'object' && value !== null) {
          for (const [op, val] of Object.entries(value as Record<string, unknown>)) {
            if (op === '_eq') qb.where(key, '=', val as string)
            else if (op === '_neq') qb.where(key, '!=', val as string)
            else if (op === '_in') qb.whereIn(key, val as string[])
            else if (op === '_nin') qb.whereNotIn(key, val as string[])
          }
        } else {
          qb.where(key, '=', value as string)
        }
      }
    }
  }

  // Hidden accounts: rows flagged is_redacted, plus rows the anonymiser
  // scrubbed by email only ('Redacted_…') and legacy import placeholders
  // ('legacy-…') whose flag was never set. The EFP clients used to hide the
  // email-prefix rows per page, which blanked whole pages and inflated the
  // page count because the server still returned and counted them.
  const applyHiddenAccountFilter = (qb: Knex.QueryBuilder) => {
    qb.where('is_redacted', false)
      .whereRaw(`email not like 'legacy-%'`)
      .whereRaw(`email not like 'Redacted\\_%' escape '\\'`)
  }

  const listQ = db<User>('nivaro_users').select(directory ? DIRECTORY_USER_COLS : USER_COLS)
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
  } else {
    listQ.orderBy('created_at', 'desc')
  }

  const countQ = db('nivaro_users').count('id as count')
  applyHiddenAccountFilter(countQ)
  applySuspendedFilter(countQ)
  if (!directory) applyConditions(countQ)
  else if (search) applyConditions(countQ)

  const [users, [{ count }]] = await Promise.all([listQ.limit(limit).offset(offset), countQ])
  const rows = users as unknown as User[]
  // parsePreferences would be a no-op here — directory rows never select it.
  return {
    data: directory ? rows : rows.map((u) => parsePreferences(u)),
    total: Number(count)
  }
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
