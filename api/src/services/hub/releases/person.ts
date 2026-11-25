import { db } from '../../../db/index.js'

/**
 * Whether the person an unattended run acts for (a schedule's creator, a train's starter) may
 * still start Hub promotions: the account exists, is active, and its role is an administrator
 * role with sign-in on. Release-operation writes are admin-only, so an owner who is not an
 * admin never scheduled anything. Read fresh at every start (never cached).
 */
export type PersonCheck = { ok: true; name: string } | { ok: false; why: string }

export async function personCanAct(userId: string | null): Promise<PersonCheck> {
  if (!userId) return { ok: false, why: 'it names nobody' }
  const u = (await db('nivaro_users')
    .where({ id: userId })
    .first('id', 'status', 'role', 'first_name', 'last_name', 'email')) as
    | Record<string, unknown>
    | undefined
  if (!u) return { ok: false, why: 'the person who set it up no longer exists' }
  const name =
    [u.first_name, u.last_name]
      .filter((x) => typeof x === 'string' && x.trim())
      .join(' ')
      .trim() || String(u.email ?? userId)
  if (String(u.status ?? 'active') !== 'active')
    return { ok: false, why: `${name} is no longer active` }
  const role = u.role
    ? ((await db('nivaro_roles').where({ id: u.role }).first('admin_access', 'app_access')) as
        | { admin_access?: unknown; app_access?: unknown }
        | undefined)
    : undefined
  const truthy = (v: unknown) => v === true || v === 1 || v === '1'
  if (!role || !truthy(role.admin_access))
    return { ok: false, why: `${name} is no longer a Hub administrator` }
  if (role.app_access === false || role.app_access === 0)
    return { ok: false, why: `${name} can no longer sign in` }
  return { ok: true, name }
}

/** The display names of these people (one read; an unknown id keeps no name). */
export async function personNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))]
  const out = new Map<string, string>()
  if (!list.length) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', list)
    .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
  for (const u of rows) {
    const name =
      [u.first_name, u.last_name]
        .filter((x) => typeof x === 'string' && x.trim())
        .join(' ')
        .trim() || String(u.email ?? '')
    if (name) out.set(String(u.id).toLowerCase(), name)
  }
  return out
}
