import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { humanCollection, type RoleChangeFact, roleChangeSentence } from './access-words.js'

/**
 * #1958 — a role's pending permission changes, in words, before they save.
 *
 * Each change is judged against the role's CURRENT policies with the same
 * matching the permission simulator and can() use: a (collection, action)
 * policy or the role's `*` wildcard for that action grants it. So
 * "removing update on invoices" reads as no change while the wildcard still
 * grants it, and "granting read" on a collection the wildcard already covers
 * reads as no change too. Row counts are the table's approximate size
 * (partition stats on SQL Server — no table scan).
 */

export interface RoleChange {
  collection: string
  action: string
  grant: boolean
}

export interface RoleChangeImpact {
  role: { id: string; name: string; admin_access: boolean }
  members: number
  changes: Array<RoleChangeFact & { collection: string }>
  summary: string
}

const ACTIONS = new Set(['create', 'read', 'update', 'delete'])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$|^\*$/

export async function approxRows(collections: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const names = [...new Set(collections.filter((c) => c !== '*' && IDENT.test(c)))]
  if (names.length === 0) return out
  try {
    if (isMssql(db)) {
      const rows = (await db.raw(
        `SELECT t.name AS table_name, SUM(p.row_count) AS n
           FROM sys.tables t
           JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
          WHERE t.name IN (${names.map(() => '?').join(',')})
          GROUP BY t.name`,
        names
      )) as Array<{ table_name: string; n: number }>
      for (const r of rows) out.set(r.table_name, Number(r.n))
      return out
    }
  } catch {
    /* fall through to counts */
  }
  for (const n of names.slice(0, 20)) {
    try {
      const row = (await db(n).count({ n: '*' }).first()) as { n: number | string } | undefined
      out.set(n, Number(row?.n ?? 0))
    } catch {
      /* unknown table: rows stay unknown */
    }
  }
  return out
}

export function parseRoleChanges(input: unknown): RoleChange[] {
  if (!Array.isArray(input)) return []
  const out: RoleChange[] = []
  for (const raw of input.slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    const collection = String(c.collection ?? '')
    const action = String(c.action ?? '')
    if (!IDENT.test(collection) || !ACTIONS.has(action)) continue
    out.push({ collection, action, grant: c.grant === true })
  }
  return out
}

/**
 * Judge each change against the current policy set. Pure — the IO wrapper
 * below supplies the policy keys and labels.
 */
export function judgeRoleChanges(
  roleName: string,
  changes: RoleChange[],
  held: Set<string>,
  label: (collection: string) => string,
  rows: Map<string, number>
): Array<RoleChangeFact & { collection: string }> {
  // Net out a change and its reversal in the same batch (toggle on, then off).
  const net = new Map<string, RoleChange>()
  for (const c of changes) {
    const k = `${c.collection}:${c.action}`
    const prev = net.get(k)
    if (prev && prev.grant !== c.grant) net.delete(k)
    else net.set(k, c)
  }
  return [...net.values()].map((c) => {
    const exact = held.has(`${c.collection}:${c.action}`)
    const wildcard = c.collection !== '*' && held.has(`*:${c.action}`)
    let noEffect: string | null = null
    if (c.grant && exact)
      noEffect = `${roleName} already has ${c.action} on ${label(c.collection)}.`
    else if (c.grant && wildcard)
      noEffect = `Granting ${c.action} on ${label(c.collection)} changes nothing — the role's "all collections" ${c.action} policy already covers it.`
    else if (!c.grant && !exact)
      noEffect = `${roleName} has no ${c.action} policy on ${label(c.collection)} to remove.`
    else if (!c.grant && wildcard)
      noEffect = `Removing ${c.action} on ${label(c.collection)} changes nothing yet — the role's "all collections" ${c.action} policy still grants it.`
    return {
      collection: c.collection,
      collection_label: label(c.collection),
      action: c.action,
      grant: c.grant,
      rows: c.collection === '*' ? null : (rows.get(c.collection) ?? null),
      no_effect: noEffect
    }
  })
}

export async function explainRoleChange(
  roleId: string,
  rawChanges: unknown
): Promise<RoleChangeImpact | null> {
  const role = (await db('nivaro_roles')
    .where({ id: roleId })
    .first('id', 'name', 'admin_access')) as
    | { id: string; name: string; admin_access: boolean | number }
    | undefined
  if (!role) return null
  const admin = role.admin_access === true || role.admin_access === 1
  const changes = parseRoleChanges(rawChanges)
  const members = Number(
    (
      (await db('nivaro_users')
        .where({ role: roleId })
        .where((q) => void q.where('status', 'active').orWhereNull('status'))
        .count({ n: '*' })
        .first()) as { n: number | string } | undefined
    )?.n ?? 0
  )
  if (admin) {
    return {
      role: { id: String(role.id), name: role.name, admin_access: true },
      members,
      changes: [],
      summary: `${role.name} is an administrator role — it bypasses permissions entirely, so these changes would not alter what it can do.`
    }
  }
  const policies = (await db('nivaro_policies')
    .where({ role: roleId })
    .select('collection', 'action')) as Array<{ collection: string; action: string }>
  const held = new Set(policies.map((p) => `${p.collection}:${p.action}`))
  const colls = (await db('nivaro_collections')
    .whereIn(
      'collection',
      changes.map((c) => c.collection)
    )
    .select('collection', 'display_name')
    .catch(() => [])) as Array<{ collection: string; display_name: string | null }>
  const names = new Map(colls.map((c) => [c.collection, c.display_name]))
  const label = (c: string) => (c === '*' ? 'every collection' : humanCollection(c, names.get(c)))
  const rows = await approxRows(changes.map((c) => c.collection))
  const facts = judgeRoleChanges(role.name, changes, held, label, rows)
  return {
    role: { id: String(role.id), name: role.name, admin_access: false },
    members,
    changes: facts,
    summary: roleChangeSentence(role.name, facts, members)
  }
}
