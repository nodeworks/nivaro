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
}): Promise<User> {
  const existing = await db<User>('nivaro_users')
    .where({ external_id: profile.sub })
    .orWhere({ email: profile.email })
    .first()

  const adRole = await resolveRoleFromAdGroups(profile.groups ?? [])

  if (existing) {
    const updates: Record<string, unknown> = {
      external_id: profile.sub,
      last_access: new Date(),
      updated_at: new Date()
    }
    if (profile.given_name) updates.first_name = profile.given_name
    if (profile.family_name) updates.last_name = profile.family_name
    if (adRole) updates.role = adRole
    await db('nivaro_users').where({ id: existing.id }).update(updates)
    return {
      ...existing,
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
      external_id: profile.sub,
      role: assignedRole,
      status: 'active',
      last_access: new Date()
    })
    .returning('id')) as unknown as [string]

  return db<User>('nivaro_users').where({ id }).first() as Promise<User>
}

export async function getUser(id: string): Promise<User | undefined> {
  return db<User>('nivaro_users').where({ id }).first()
}

const USER_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'role',
  'status',
  'last_access',
  'manager_id',
  'delegate_id',
  'delegate_expires_at',
  'is_out_of_office',
  'created_at'
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
  } = {}
) {
  const { limit = 25, offset = 0, search, sort, filter } = opts

  const applyConditions = (qb: Knex.QueryBuilder) => {
    if (search) {
      qb.where((inner) => {
        inner
          .orWhere('first_name', 'like', `%${search}%`)
          .orWhere('last_name', 'like', `%${search}%`)
          .orWhere('email', 'like', `%${search}%`)
      })
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

  const listQ = db<User>('nivaro_users').select(USER_COLS).where('is_redacted', false)
  applyConditions(listQ)

  if (sort) {
    const col = sort.startsWith('-') ? sort.slice(1) : sort
    const dir = sort.startsWith('-') ? 'desc' : 'asc'
    listQ.orderBy(SORTABLE_USER_COLS.has(col) ? col : 'created_at', dir)
  } else {
    listQ.orderBy('created_at', 'desc')
  }

  const countQ = db('nivaro_users').count('id as count').where('is_redacted', false)
  applyConditions(countQ)

  const [users, [{ count }]] = await Promise.all([listQ.limit(limit).offset(offset), countQ])
  return { data: users, total: Number(count) }
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
  await db('nivaro_users')
    .where({ id })
    .update({ ...data, updated_at: new Date() })
  return getUser(id)
}

export async function updateLastPage(id: string, path: string) {
  await db('nivaro_users').where({ id }).update({ last_page: path, updated_at: new Date() })
}
