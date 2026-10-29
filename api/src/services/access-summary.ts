/**
 * #12 Permission summary in words — the facts half.
 *
 * Per role (Roles page) or per person (people page Access tab): what they can
 * see, add, edit and delete, which fields and rows their role leaves out, the
 * User Scopes that narrow it, and the pages turned off. Every fact comes from
 * the enforcement functions themselves, so the words cannot disagree with
 * what the API does:
 *
 *   can()              → see / add / edit / delete
 *   getAllowedFields() → field lists (null = every field)
 *   getRowFilter()     → row rules per action
 *   routeScopeGates()  → which restrict scopes reach a collection (the same
 *                        routing compileAccessGates runs on every read)
 *
 * A role's policies differ only on collections they NAME: every collection
 * without its own policy row answers exactly like the wildcard (`*`) does, so
 * one of them is asked and the answer reused for the rest (system tables are
 * never listed). The phrasing is services/access-summary-words.ts.
 */
import { db } from '../db/index.js'
import type { User } from '../types.js'
import {
  type AccessSummaryWords,
  buildAccessSummary,
  type SummaryCollectionFacts,
  type SummaryScopeFact,
  type SummaryVoice
} from './access-summary-words.js'
import { humanCollection, personName } from './access-words.js'
import { selectInChunks } from './db-batch.js'
import {
  type Action,
  can,
  getAllowedFields,
  getRowFilter,
  type RowCondition
} from './permissions.js'
import { routeScopeGates } from './record-access.js'
import { approxRows } from './role-change-impact.js'
import { isSystemCollection } from './system-collections.js'
import { getUserScopes, listScopeDimensions, type ScopeDimension } from './user-scopes.js'

export type AccessSummaryTarget = { role: string } | { user: string }

export interface AccessSummary extends AccessSummaryWords {
  subject: {
    kind: 'role' | 'user'
    id: string
    name: string
    role_id: string | null
    role_name: string | null
    admin: boolean
    app_access: boolean
  }
  voice: SummaryVoice
  collections: Array<
    Omit<SummaryCollectionFacts, 'all_fields' | 'field_labels'> & { hidden_fields: string[] }
  >
  ui_disabled: string[]
  closed_count: number
  member_count: number | null
}

const SIM_ID = '00000000-0000-0000-0000-000000000000'
const ACTIONS: Action[] = ['read', 'create', 'update', 'delete']

type Answer = Pick<
  SummaryCollectionFacts,
  'read' | 'create' | 'update' | 'delete' | 'read_fields' | 'update_fields' | 'row_filter'
>

/** What the enforcement functions answer for one collection. */
export async function enforcementAnswer(user: User, collection: string): Promise<Answer> {
  const [read, create, update, del] = await Promise.all(
    ACTIONS.map((a) => can(user, a, collection).catch(() => false))
  )
  const [readFields, updateFields, readRule, updateRule, deleteRule] = await Promise.all([
    read ? getAllowedFields(user, 'read', collection) : Promise.resolve([] as string[]),
    update ? getAllowedFields(user, 'update', collection) : Promise.resolve([] as string[]),
    read ? getRowFilter(user, 'read', collection) : Promise.resolve(null),
    update ? getRowFilter(user, 'update', collection) : Promise.resolve(null),
    del ? getRowFilter(user, 'delete', collection) : Promise.resolve(null)
  ])
  return {
    read,
    create,
    update,
    delete: del,
    read_fields: readFields,
    update_fields: updateFields,
    row_filter: {
      read: (readRule as RowCondition[] | null) ?? null,
      update: (updateRule as RowCondition[] | null) ?? null,
      delete: (deleteRule as RowCondition[] | null) ?? null
    }
  }
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

function parsePaths(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

async function scopeValueLabels(
  dim: ScopeDimension,
  values: Array<string | number>
): Promise<string[]> {
  const ids = values.slice(0, 8).map(String)
  if (!ids.length) return []
  try {
    const rows = (await db(dim.target_collection)
      .whereIn('id', ids as never)
      .select('id', db.raw('?? as label', [dim.display_field || 'name']))) as Array<{
      id: unknown
      label: unknown
    }>
    const m = new Map(rows.map((r) => [String(r.id), String(r.label ?? r.id)]))
    return ids.map((i) => m.get(i) ?? i)
  } catch {
    return ids
  }
}

/**
 * `viewerIsAdmin`: a non-admin may only ask about themselves (the route
 * enforces it); their own summary never names a field their role hides
 * from them, nor how many collections are closed to them.
 */
export async function summarizeAccess(
  target: AccessSummaryTarget,
  opts: { viewerIsAdmin: boolean; self: boolean }
): Promise<AccessSummary | null> {
  // ── who ──
  let user: User
  let name: string
  let kind: 'role' | 'user'
  let roleId: string | null
  if ('role' in target) {
    roleId = target.role
    kind = 'role'
    user = { id: SIM_ID, role: roleId, email: 'simulated@nivaro', status: 'active' } as never
    name = ''
  } else {
    const row = (await db('nivaro_users').where({ id: target.user }).first()) as
      | (User & { first_name?: string | null; last_name?: string | null })
      | undefined
    if (!row) return null
    user = row
    kind = 'user'
    roleId = (row.role as string | null) ?? null
    name = (row.first_name ?? '').trim() || personName(row)
  }
  const role = roleId
    ? ((await db('nivaro_roles').where({ id: roleId }).first()) as
        | {
            id: string
            name: string
            admin_access?: boolean | number
            app_access?: boolean | number | null
            ui_permissions?: string | null
          }
        | undefined)
    : undefined
  if (kind === 'role' && !role) return null
  if (kind === 'role') name = role!.name
  const voice: SummaryVoice = kind === 'role' ? 'role' : opts.self ? 'self' : 'third'
  const admin = !!role?.admin_access
  const appAccess = role ? role.app_access == null || !!role.app_access : true
  const uiDisabled = admin ? [] : parsePaths(role?.ui_permissions)
  const subject = {
    kind,
    id: kind === 'role' ? String(roleId) : String(user.id),
    name,
    role_id: roleId,
    role_name: role?.name ?? null,
    admin,
    app_access: appAccess
  }

  const memberRows =
    kind === 'role' && roleId
      ? ((await db('nivaro_users')
          .where({ role: roleId })
          .select('id')
          .catch(() => [])) as Array<{ id: string }>)
      : []
  const memberCount = kind === 'role' ? memberRows.length : null

  if (admin || !role) {
    const words = buildAccessSummary({
      voice,
      name,
      role_name: role?.name ?? null,
      admin,
      no_role: !role,
      app_access: appAccess,
      collections: [],
      closed_count: 0,
      ui_disabled: [],
      member_count: memberCount ?? undefined
    })
    return {
      ...words,
      subject,
      voice,
      collections: [],
      ui_disabled: [],
      closed_count: 0,
      member_count: memberCount
    }
  }

  // ── which collections ──
  const [policyRows, registeredRows, junctionRows, boundRows, treeRows] = await Promise.all([
    db('nivaro_policies').where({ role: roleId }).select('collection', 'action') as Promise<
      Array<{ collection: string; action: string }>
    >,
    db('nivaro_collections')
      .select('collection', 'display_name', 'hidden')
      .catch(() => []) as Promise<
      Array<{ collection: string; display_name?: string | null; hidden?: boolean | number }>
    >,
    db('nivaro_relations')
      .whereNotNull('junction_field')
      .select('many_collection')
      .catch(() => []) as Promise<Array<{ many_collection: string }>>,
    db('nivaro_workflow_bindings')
      .select('collection')
      .catch(() => []) as Promise<Array<{ collection: string }>>,
    db('nivaro_tree_permissions')
      .where({ role: roleId })
      .select('collection')
      .catch(() => []) as Promise<Array<{ collection: string }>>
  ])
  const junctions = new Set(junctionRows.map((r) => r.many_collection))
  const display = new Map(registeredRows.map((r) => [r.collection, r.display_name ?? null]))
  const business = (c: string) => !!c && c !== '*' && !isSystemCollection(c) && !junctions.has(c)
  const named = new Set(policyRows.map((p) => p.collection).filter(business))
  const hasWildcard = policyRows.some((p) => p.collection === '*')
  const others = registeredRows
    .filter((r) => business(r.collection) && !named.has(r.collection))
    .filter((r) => !(r.hidden === true || r.hidden === 1))
    .map((r) => r.collection)
  const namedList = [...named].filter((c) => display.has(c))

  // Named collections: asked one by one. Every other one answers like the
  // wildcard — ask one of them (any) and reuse it.
  const answers = new Map<string, Answer>()
  for (const [c, a] of (await inBatches(namedList, 6, async (c) => [
    c,
    await enforcementAnswer(user, c)
  ])) as Array<[string, Answer]>)
    answers.set(c, a)
  const wildcard = hasWildcard && others.length ? await enforcementAnswer(user, others[0]) : null
  if (wildcard) for (const c of others) answers.set(c, wildcard)

  const open = [...answers.entries()].filter(([, a]) => a.read || a.create || a.update || a.delete)
  const openSet = new Set(open.map(([c]) => c))
  const closedCount = registeredRows.filter(
    (r) =>
      business(r.collection) && !(r.hidden === true || r.hidden === 1) && !openSet.has(r.collection)
  ).length

  // ── scopes: the person's own, or every restrict scope the role's people hold ──
  const dims = await listScopeDimensions().catch(() => [] as ScopeDimension[])
  type Restrict = { dimension: string; values: Array<string | number> }
  let restricts: Restrict[] = []
  const membersByDim = new Map<string, number>()
  if (kind === 'user') {
    restricts = (await getUserScopes(String(user.id)).catch(() => [])).filter(
      (s) => s.mode === 'restrict' && s.values.length > 0
    )
  } else if (memberRows.length && dims.length) {
    const rows = (await selectInChunks(
      memberRows.map((m) => m.id),
      1000,
      (chunk) =>
        db('nivaro_user_scopes')
          .whereIn('user', chunk as never)
          .where({ mode: 'restrict' })
          .select('user', 'dimension', 'values') as Promise<
          Array<{ user: string; dimension: string; values: unknown }>
        >
    ).catch(() => [])) as Array<{ user: string; dimension: string; values: unknown }>
    const who = new Map<string, Set<string>>()
    for (const r of rows) {
      let vals: unknown = r.values
      if (typeof vals === 'string')
        try {
          vals = JSON.parse(vals)
        } catch {
          vals = []
        }
      if (!Array.isArray(vals) || vals.length === 0) continue
      const s = who.get(r.dimension) ?? new Set<string>()
      s.add(String(r.user).toLowerCase())
      who.set(r.dimension, s)
    }
    for (const [d, s] of who) membersByDim.set(d, s.size)
    restricts = [...who.keys()].map((d) => ({ dimension: d, values: ['*'] }))
  }
  const dimByName = new Map(dims.map((d) => [d.name, d]))
  const valueLabels = new Map<string, string[]>()
  if (kind === 'user')
    for (const r of restricts) {
      const d = dimByName.get(r.dimension)
      if (d) valueLabels.set(r.dimension, await scopeValueLabels(d, r.values))
    }

  // ── field universe + labels (only where a list or a rule names fields) ──
  const needFields = open
    .filter(
      ([, a]) =>
        (a.read && a.read_fields !== null) ||
        (a.update && a.update_fields !== null) ||
        a.row_filter.read ||
        a.row_filter.update ||
        a.row_filter.delete
    )
    .map(([c]) => c)
  const fieldRows = needFields.length
    ? ((await selectInChunks(
        needFields,
        1000,
        (chunk) =>
          db('nivaro_fields')
            .whereIn('collection', chunk as never)
            .select('collection', 'field', 'label') as Promise<
            Array<{ collection: string; field: string; label?: string | null }>
          >
      ).catch(() => [])) as Array<{ collection: string; field: string; label?: string | null }>)
    : []
  const fieldsOf = new Map<string, { all: string[]; labels: Record<string, string> }>()
  for (const r of fieldRows) {
    const e = fieldsOf.get(r.collection) ?? { all: [], labels: {} }
    e.all.push(r.field)
    if (r.label) e.labels[r.field] = String(r.label)
    fieldsOf.set(r.collection, e)
  }

  // ── most used first: collections with a pipeline, then the biggest ──
  const bound = [...new Set(boundRows.map((r) => r.collection))]
  const sizes = await approxRows(open.map(([c]) => c)).catch(() => new Map<string, number>())
  const rankOf = (c: string) => {
    const b = bound.indexOf(c)
    return b >= 0 ? b : bound.length + 1 + 1 / (1 + (sizes.get(c) ?? 0))
  }
  const tree = new Set(treeRows.map((r) => r.collection))

  const facts: SummaryCollectionFacts[] = []
  for (const [c, a] of open) {
    const routed = a.read
      ? await routeScopeGates(restricts, dims, c).catch(() => ({ scopes: [], strict: null }))
      : { scopes: [], strict: null }
    const scopes: SummaryScopeFact[] = routed.scopes.map((g) =>
      kind === 'user'
        ? { label: g.label, values: valueLabels.get(g.dimension) ?? [] }
        : { label: g.label, members: membersByDim.get(g.dimension) ?? 0, of: memberCount ?? 0 }
    )
    const fl = fieldsOf.get(c)
    facts.push({
      collection: c,
      label: humanCollection(c, display.get(c)),
      rank: rankOf(c),
      ...a,
      all_fields: fl?.all ?? [],
      field_labels: fl?.labels ?? {},
      scopes,
      strict: routed.strict?.label ?? null,
      tree_rules: tree.has(c)
    })
  }

  const conceal = voice === 'self' && !opts.viewerIsAdmin
  const words = buildAccessSummary({
    voice,
    name,
    role_name: role.name,
    admin: false,
    app_access: appAccess,
    collections: facts,
    closed_count: closedCount,
    ui_disabled: uiDisabled,
    member_count: memberCount ?? undefined,
    conceal_hidden_fields: conceal
  })
  return {
    ...words,
    subject,
    voice,
    collections: facts
      .sort((x, z) => x.rank - z.rank)
      .map(({ all_fields, field_labels: _l, ...f }) => ({
        ...f,
        hidden_fields:
          conceal || !f.read || f.read_fields === null
            ? []
            : all_fields.filter((x) => x !== 'id' && !f.read_fields!.includes(x)),
        // A person's own summary carries the words only: no field list or
        // rule condition that could name a field their role hides.
        ...(conceal
          ? {
              read_fields: null,
              update_fields: null,
              row_filter: { read: null, update: null, delete: null }
            }
          : {})
      })),
    ui_disabled: uiDisabled,
    closed_count: conceal ? 0 : closedCount,
    member_count: memberCount
  }
}
