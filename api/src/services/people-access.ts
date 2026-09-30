import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import {
  bustUserScopeCache,
  getUserScopes,
  listScopeDimensions,
  type ScopeDimension
} from './user-scopes.js'

/**
 * #637 — Copy access from one person to another, and #641 — the Users list
 * bulk actions. Both are admin-only and both write person by person with an
 * activity row each, so an audit reads the same as a hand edit.
 */

type ScopeValue = string | number

export interface ScopeChange {
  dimension: string
  label: string
  mode: 'default' | 'restrict'
  current: Array<{ id: ScopeValue; label: string }>
  proposed: Array<{ id: ScopeValue; label: string }>
}

export interface AccessCopyPlan {
  from: { id: string; name: string }
  to: { id: string; name: string }
  role: {
    current: { id: string | null; name: string | null }
    proposed: { id: string | null; name: string | null }
    grants_admin: boolean
  } | null
  scopes: ScopeChange[]
  teams: {
    add: Array<{ id: number; name: string }>
    /** Teams the target is in that the source is not — left alone. */
    keeps: Array<{ id: number; name: string }>
  } | null
  /** Nothing to do: the two already match on everything asked for. */
  empty: boolean
}

export interface CopyInclude {
  role?: boolean
  scopes?: boolean
  teams?: boolean
}

const personName = (r: Record<string, unknown> | undefined) =>
  r ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || String(r.email ?? r.id) : ''

const sameSet = (a: ScopeValue[], b: ScopeValue[]) => {
  const norm = (v: ScopeValue[]) =>
    [...new Set(v.map((x) => String(x).toLowerCase()))].sort().join('|')
  return norm(a) === norm(b)
}

/** Display labels for a dimension's target ids, one read per dimension. */
async function labelValues(
  dim: ScopeDimension,
  ids: ScopeValue[]
): Promise<Array<{ id: ScopeValue; label: string }>> {
  if (ids.length === 0) return []
  const field = dim.display_field || 'id'
  const rows = (await db(dim.target_collection)
    .whereIn('id', ids as string[])
    .select('id', `${field} as label`)
    .catch(() => [])) as Array<{ id: ScopeValue; label: unknown }>
  const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r.label]))
  return ids.map((id) => ({
    id,
    label: String(byId.get(String(id).toLowerCase()) ?? id)
  }))
}

export async function buildAccessCopyPlan(
  toId: string,
  fromId: string,
  include: CopyInclude
): Promise<AccessCopyPlan> {
  if (String(toId).toUpperCase() === String(fromId).toUpperCase())
    throw Object.assign(new Error('Pick a different person to copy from'), { statusCode: 400 })
  const people = (await db('nivaro_users as u')
    .leftJoin('nivaro_roles as r', 'u.role', 'r.id')
    .whereIn('u.id', [toId, fromId])
    .select(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.role',
      'r.name as role_name',
      'r.admin_access as role_admin'
    )) as Array<Record<string, unknown>>
  const find = (id: string) =>
    people.find((p) => String(p.id).toUpperCase() === String(id).toUpperCase())
  const to = find(toId)
  const from = find(fromId)
  if (!to || !from) throw Object.assign(new Error('User not found'), { statusCode: 404 })

  let role: AccessCopyPlan['role'] = null
  if (include.role && String(to.role ?? '') !== String(from.role ?? '')) {
    role = {
      current: {
        id: (to.role as string | null) ?? null,
        name: (to.role_name as string | null) ?? null
      },
      proposed: {
        id: (from.role as string | null) ?? null,
        name: (from.role_name as string | null) ?? null
      },
      grants_admin: !!from.role_admin && !to.role_admin
    }
  }

  const scopes: ScopeChange[] = []
  if (include.scopes) {
    const [dims, toRows, fromRows] = await Promise.all([
      listScopeDimensions(false),
      getUserScopes(String(to.id)),
      getUserScopes(String(from.id))
    ])
    for (const dim of dims) {
      for (const mode of ['restrict', 'default'] as const) {
        const cur = toRows.find((r) => r.dimension === dim.name && r.mode === mode)?.values ?? []
        const next = fromRows.find((r) => r.dimension === dim.name && r.mode === mode)?.values ?? []
        if (sameSet(cur, next)) continue
        scopes.push({
          dimension: dim.name,
          label: dim.label,
          mode,
          current: await labelValues(dim, cur),
          proposed: await labelValues(dim, next)
        })
      }
    }
  }

  let teams: AccessCopyPlan['teams'] = null
  if (include.teams) {
    const rows = (await db('nivaro_user_group_members as m')
      .join('nivaro_user_groups as g', 'g.id', 'm.group_id')
      .whereIn('m.user', [String(to.id), String(from.id)])
      .select('m.user', 'g.id', 'g.name')) as Array<{ user: string; id: number; name: string }>
    const isTo = (u: string) => String(u).toUpperCase() === String(to.id).toUpperCase()
    const toTeams = new Set(rows.filter((r) => isTo(r.user)).map((r) => Number(r.id)))
    const fromTeams = rows.filter((r) => !isTo(r.user))
    const fromIds = new Set(fromTeams.map((r) => Number(r.id)))
    teams = {
      add: fromTeams
        .filter((r) => !toTeams.has(Number(r.id)))
        .map((r) => ({ id: Number(r.id), name: r.name })),
      keeps: rows
        .filter((r) => isTo(r.user) && !fromIds.has(Number(r.id)))
        .map((r) => ({ id: Number(r.id), name: r.name }))
    }
  }

  return {
    from: { id: String(from.id), name: personName(from) },
    to: { id: String(to.id), name: personName(to) },
    role,
    scopes,
    teams,
    empty: !role && scopes.length === 0 && (!teams || teams.add.length === 0)
  }
}

/** Apply a plan built a moment ago — rebuilt here so a stale client plan can never write. */
export async function applyAccessCopy(
  toId: string,
  fromId: string,
  include: CopyInclude,
  actorId: string
): Promise<AccessCopyPlan> {
  const plan = await buildAccessCopyPlan(toId, fromId, include)
  if (plan.empty) return plan
  const target = plan.to.id
  if (plan.role) {
    await db('nivaro_users').where({ id: target }).update({ role: plan.role.proposed.id })
  }
  for (const c of plan.scopes) {
    const where = { user: target, dimension: c.dimension, mode: c.mode }
    const values = c.proposed.map((v) => v.id)
    const existing = await db('nivaro_user_scopes').where(where).first('id')
    if (values.length === 0) {
      if (existing) await db('nivaro_user_scopes').where({ id: existing.id }).del()
    } else if (existing) {
      await db('nivaro_user_scopes')
        .where({ id: existing.id })
        .update({ values: JSON.stringify(values), updated_at: new Date() })
    } else {
      await db('nivaro_user_scopes').insert({
        ...where,
        values: JSON.stringify(values),
        updated_at: new Date()
      })
    }
  }
  if (plan.scopes.length > 0) bustUserScopeCache(target)
  for (const t of plan.teams?.add ?? []) {
    await db('nivaro_user_group_members').insert({ group_id: t.id, user: target })
  }
  const parts = [
    plan.role ? `role ${plan.role.current.name ?? '—'} → ${plan.role.proposed.name ?? '—'}` : null,
    plan.scopes.length ? `${plan.scopes.length} scope${plan.scopes.length === 1 ? '' : 's'}` : null,
    plan.teams?.add.length ? `teams + ${plan.teams.add.map((t) => t.name).join(', ')}` : null
  ].filter(Boolean)
  await logActivity({
    action: 'copy-access',
    user: actorId,
    collection: 'nivaro_users',
    item: target,
    comment: `From ${plan.from.name}: ${parts.join('; ')}`
  })
  return plan
}

// ── #641 Users list bulk actions ─────────────────────────────────────────────

export type BulkUserAction =
  | { action: 'set_role'; role_id: string }
  | { action: 'suspend' }
  | { action: 'activate' }
  | { action: 'set_delegate'; delegate_id: string | null; expires_at?: string | null }
  | { action: 'add_to_team'; team_id: number }

export interface BulkUserResult {
  id: string
  name: string
  outcome: 'changed' | 'skipped' | 'failed'
  reason?: string
}

export async function runBulkUserAction(
  ids: string[],
  a: BulkUserAction,
  actorId: string
): Promise<{ results: BulkUserResult[]; changed: number; skipped: number; failed: number }> {
  const unique = [...new Set(ids.map((i) => String(i).toUpperCase()))]
  const rows = (await db('nivaro_users')
    .whereIn('id', unique)
    .select(
      'id',
      'first_name',
      'last_name',
      'email',
      'role',
      'status',
      'delegate_id',
      'account_kind'
    )) as Array<Record<string, unknown>>
  const byId = new Map(rows.map((r) => [String(r.id).toUpperCase(), r]))

  // Validate the action's own argument once, before touching anyone.
  let roleName: string | null = null
  let teamName: string | null = null
  let delegateName: string | null = null
  if (a.action === 'set_role') {
    const r = await db('nivaro_roles').where({ id: a.role_id }).first('id', 'name')
    if (!r) throw Object.assign(new Error('Role not found'), { statusCode: 400 })
    roleName = String(r.name)
  }
  if (a.action === 'add_to_team') {
    const t = await db('nivaro_user_groups').where({ id: a.team_id }).first('id', 'name')
    if (!t) throw Object.assign(new Error('Team not found'), { statusCode: 400 })
    teamName = String(t.name)
  }
  if (a.action === 'set_delegate' && a.delegate_id) {
    const d = await db('nivaro_users')
      .where({ id: a.delegate_id })
      .first('id', 'status', 'first_name', 'last_name', 'email')
    if (!d) throw Object.assign(new Error('Delegate not found'), { statusCode: 400 })
    if (String(d.status ?? '').toLowerCase() === 'suspended')
      throw Object.assign(new Error('That delegate is suspended'), { statusCode: 400 })
    delegateName = personName(d)
  }
  const teamMembers =
    a.action === 'add_to_team'
      ? new Set(
          (
            (await db('nivaro_user_group_members')
              .where({ group_id: a.team_id })
              .pluck('user')) as string[]
          ).map((u) => String(u).toUpperCase())
        )
      : new Set<string>()

  const results: BulkUserResult[] = []
  for (const id of unique) {
    const u = byId.get(id)
    if (!u) {
      results.push({ id, name: id, outcome: 'failed', reason: 'No such user' })
      continue
    }
    const name = personName(u)
    const self = id === String(actorId).toUpperCase()
    const skip = (reason: string) => results.push({ id, name, outcome: 'skipped', reason })
    try {
      let comment = ''
      let action = 'update'
      if (a.action === 'set_role') {
        if (self) {
          skip('You cannot change your own role here')
          continue
        }
        if (String(u.role ?? '').toUpperCase() === String(a.role_id).toUpperCase()) {
          skip(`Already ${roleName}`)
          continue
        }
        await db('nivaro_users').where({ id: u.id }).update({ role: a.role_id })
        comment = `Bulk: role → ${roleName}`
      } else if (a.action === 'suspend' || a.action === 'activate') {
        const next = a.action === 'suspend' ? 'suspended' : 'active'
        if (self && next === 'suspended') {
          skip('You cannot suspend yourself')
          continue
        }
        if (String(u.status ?? 'active') === next) {
          skip(next === 'suspended' ? 'Already suspended' : 'Already active')
          continue
        }
        await db('nivaro_users').where({ id: u.id }).update({ status: next })
        comment = `Bulk: ${next === 'suspended' ? 'suspended' : 'reactivated'}`
      } else if (a.action === 'set_delegate') {
        if (a.delegate_id && id === String(a.delegate_id).toUpperCase()) {
          skip('A person cannot delegate to themselves')
          continue
        }
        if (
          String(u.delegate_id ?? '').toUpperCase() === String(a.delegate_id ?? '').toUpperCase()
        ) {
          skip(a.delegate_id ? `Already delegates to ${delegateName}` : 'Has no delegate')
          continue
        }
        await db('nivaro_users')
          .where({ id: u.id })
          .update({
            delegate_id: a.delegate_id ?? null,
            delegate_expires_at: a.expires_at ? new Date(a.expires_at) : null
          })
        action = 'delegation-assign'
        comment = `Bulk: delegate → ${delegateName ?? 'none'}${a.expires_at ? ` until ${String(a.expires_at).slice(0, 10)}` : ''}`
      } else if (a.action === 'add_to_team') {
        if (teamMembers.has(id)) {
          skip(`Already in ${teamName}`)
          continue
        }
        await db('nivaro_user_group_members').insert({ group_id: a.team_id, user: u.id })
        action = 'user-group-members-add'
        comment = `Bulk: added to ${teamName}`
      }
      await logActivity({
        action,
        user: actorId,
        collection: 'nivaro_users',
        item: String(u.id),
        comment
      })
      results.push({ id, name, outcome: 'changed' })
    } catch (err) {
      results.push({ id, name, outcome: 'failed', reason: (err as Error).message.slice(0, 200) })
    }
  }
  if (a.action === 'set_role' || a.action === 'suspend' || a.action === 'activate') {
    // A role or status change moves what someone may read and who can act.
    const { bustWorkingOn } = await import('./user-profile.js')
    bustWorkingOn()
  }
  return {
    results,
    changed: results.filter((r) => r.outcome === 'changed').length,
    skipped: results.filter((r) => r.outcome === 'skipped').length,
    failed: results.filter((r) => r.outcome === 'failed').length
  }
}
