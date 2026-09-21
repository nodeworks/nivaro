import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { getLabels } from './queues.js'

/**
 * "Who is still named on live work but can no longer act?" — accounts that are
 * suspended, redacted, anonymised or import placeholders, and the records,
 * seats and tasks that still point at them.
 *
 * Sources are DISCOVERED, never listed: every foreign key from a registered
 * business collection into nivaro_users, every junction leg that carries a
 * user (M2M and M2A), plus the four places the platform itself assigns people
 * (owner-group seats, teams, manual instance owners, open tasks).
 *
 * "Live" means the record sits in an open pipeline instance. A collection with
 * no pipeline has no such notion, so its records are reported separately
 * (`scope: 'all'`) and the caller decides whether to look at them.
 */

/** own = a set the PERSON holds (their saved filters, notification picks) — a link from them, not to them. */
export type LinkRole = 'assignment' | 'audit' | 'seat' | 'own'
export type InactiveReason = 'suspended' | 'redacted' | 'anonymised' | 'placeholder'

export interface LinkSource {
  key: string
  /** The collection whose records are reported (the junction's PARENT for junction legs). */
  collection: string
  collection_label: string
  field: string
  label: string
  role: LinkRole
  /** open = only records in an open pipeline instance; all = the collection has no pipeline. */
  scope: 'open' | 'all'
  kind: 'column' | 'junction' | 'm2a' | 'builtin'
  /** Records can be handed to someone else from the tool. */
  reassignable: boolean
  // junction mechanics — internal
  junction?: string
  parent_fk?: string
  discriminator?: string
}

export interface InactiveUserLinks {
  user: {
    id: string
    name: string
    email: string | null
    status: string | null
    reason: InactiveReason
    last_access: string | null
  }
  total: number
  links: Array<{ source: string; count: number }>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const AUDIT_COLUMNS = new Set([
  'user_created',
  'user_updated',
  'creator',
  'created_by',
  'updated_by',
  'modified_by',
  'changed_by',
  'imported_by',
  'added_by',
  'deleted_by'
])

/** SQL predicate over alias `u`: an account that can no longer act, and is (or was) a person. */
const INACTIVE_SQL = `(
  (u.status = 'suspended' OR u.is_redacted = 1 OR u.email LIKE 'legacy-%' OR u.email LIKE 'Redacted[_]%')
  AND (u.account_kind IS NULL OR u.account_kind = 'placeholder')
)`

function reasonOf(u: { email?: string | null; is_redacted?: unknown }): InactiveReason {
  const email = String(u.email ?? '')
  if (/^legacy-/i.test(email)) return 'placeholder'
  if (u.is_redacted === true || u.is_redacted === 1) return 'redacted'
  if (/^Redacted_/i.test(email)) return 'anonymised'
  return 'suspended'
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const BUILTIN: LinkSource[] = [
  {
    key: 'builtin:owner_seats',
    collection: 'nivaro_pipeline_owner_groups',
    collection_label: 'Pipeline owner groups',
    field: 'user',
    label: 'Owner-group seat',
    role: 'seat',
    scope: 'all',
    kind: 'builtin',
    reassignable: true
  },
  {
    key: 'builtin:teams',
    collection: 'nivaro_user_groups',
    collection_label: 'Teams',
    field: 'user',
    label: 'Team member',
    role: 'seat',
    scope: 'all',
    kind: 'builtin',
    reassignable: true
  },
  {
    key: 'builtin:instance_owners',
    collection: 'nivaro_pipeline_instance_owners',
    collection_label: 'Open records',
    field: 'user',
    label: 'Manually added owner',
    role: 'assignment',
    scope: 'open',
    kind: 'builtin',
    reassignable: true
  },
  {
    key: 'builtin:tasks',
    collection: 'nivaro_tasks',
    collection_label: 'Tasks',
    field: 'assignee',
    label: 'Open task assignee',
    role: 'assignment',
    scope: 'open',
    kind: 'builtin',
    reassignable: true
  }
]

let sourceCache: { at: number; sources: LinkSource[] } | null = null

export async function discoverLinkSources(): Promise<LinkSource[]> {
  if (sourceCache && Date.now() - sourceCache.at < 60_000) return sourceCache.sources

  const [fkCols, collections, bindings, relations, fields] = await Promise.all([
    db.raw(`
      SELECT t.name AS table_name, c.name AS column_name
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.tables t ON t.object_id = fk.parent_object_id
      JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
      WHERE fk.referenced_object_id = OBJECT_ID('nivaro_users')
    `) as Promise<Array<{ table_name: string; column_name: string }>>,
    db('nivaro_collections').select('collection', 'display_name', 'singular') as Promise<
      Array<{ collection: string; display_name: string | null; singular: string | null }>
    >,
    db('nivaro_workflow_bindings').distinct('collection') as Promise<Array<{ collection: string }>>,
    db('nivaro_relations').select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field',
      'one_collection_field',
      'one_allowed_collections'
    ) as Promise<
      Array<{
        many_collection: string
        many_field: string
        one_collection: string | null
        one_field: string | null
        junction_field: string | null
        one_collection_field: string | null
        one_allowed_collections: string | null
      }>
    >,
    db('nivaro_fields').select('collection', 'field', 'label', 'special') as Promise<
      Array<{ collection: string; field: string; label: string | null; special: string | null }>
    >
  ])

  const registered = new Map(
    collections.map((c) => [c.collection, c.display_name || titleCase(c.collection)])
  )
  const bound = new Set(bindings.map((b) => b.collection))
  const fieldMeta = new Map(fields.map((f) => [`${f.collection}.${f.field}`, f]))
  const business = (t: string) =>
    registered.has(t) && !/^(nivaro|directus)_/i.test(t) && IDENT.test(t)
  const relOf = (table: string, col: string) =>
    relations.find((r) => r.many_collection === table && r.many_field === col)

  const roleOf = (table: string, col: string): LinkRole => {
    const special = String(fieldMeta.get(`${table}.${col}`)?.special ?? '')
    if (/user-(created|updated)/.test(special) || AUDIT_COLUMNS.has(col)) return 'audit'
    return 'assignment'
  }
  const labelOf = (table: string, col: string) =>
    fieldMeta.get(`${table}.${col}`)?.label || titleCase(col)

  const out: LinkSource[] = []
  const seen = new Set<string>()
  const push = (s: LinkSource) => {
    if (seen.has(s.key)) return
    seen.add(s.key)
    out.push(s)
  }

  for (const { table_name: t, column_name: c } of fkCols) {
    if (!business(t) || !IDENT.test(c)) continue
    const rel = relOf(t, c)
    const parentLeg = rel?.junction_field ? relOf(t, rel.junction_field) : undefined
    if (
      rel?.junction_field &&
      parentLeg?.one_collection &&
      business(parentLeg.one_collection) &&
      IDENT.test(rel.junction_field)
    ) {
      // A junction leg: the record that matters is the junction's parent.
      const parent = parentLeg.one_collection
      push({
        key: `junction:${t}.${c}`,
        collection: parent,
        collection_label: registered.get(parent) ?? titleCase(parent),
        field: c,
        label: parentLeg.one_field
          ? labelOf(parent, parentLeg.one_field)
          : titleCase(t.replace(new RegExp(`^${parent}_?`), '') || c),
        // The user side carries an alias of its own: the set belongs to the person.
        role: rel.one_field ? 'own' : 'assignment',
        scope: bound.has(parent) ? 'open' : 'all',
        kind: 'junction',
        reassignable: !rel.one_field,
        junction: t,
        parent_fk: rel.junction_field
      })
      continue
    }
    push({
      key: `column:${t}.${c}`,
      collection: t,
      collection_label: registered.get(t) ?? titleCase(t),
      field: c,
      label: labelOf(t, c),
      role: roleOf(t, c),
      scope: bound.has(t) ? 'open' : 'all',
      kind: 'column',
      reassignable: roleOf(t, c) === 'assignment'
    })
  }

  // M2A legs that may hold a user: `item` is text, a discriminator column names the collection.
  for (const r of relations) {
    if (!r.one_collection_field) continue
    const allowed = String(r.one_allowed_collections ?? '')
    if (!/(nivaro|directus)_users/.test(allowed)) continue
    // The `item` leg often carries no junction_field of its own; the parent leg points back at it.
    const parentLeg = r.junction_field
      ? relOf(r.many_collection, r.junction_field)
      : relations.find(
          (x) => x.many_collection === r.many_collection && x.junction_field === r.many_field
        )
    const parent = parentLeg?.one_collection
    if (!parent || !parentLeg || !business(parent)) continue
    if (
      ![r.many_collection, r.many_field, parentLeg.many_field, r.one_collection_field].every((x) =>
        IDENT.test(x)
      )
    )
      continue
    push({
      key: `m2a:${r.many_collection}.${r.many_field}`,
      collection: parent,
      collection_label: registered.get(parent) ?? titleCase(parent),
      field: r.many_field,
      label: parentLeg?.one_field
        ? labelOf(parent, parentLeg.one_field)
        : titleCase(r.many_collection.replace(new RegExp(`^${parent}_?`), '') || r.many_field),
      role: 'assignment',
      scope: bound.has(parent) ? 'open' : 'all',
      kind: 'm2a',
      reassignable: true,
      junction: r.many_collection,
      parent_fk: parentLeg.many_field,
      discriminator: r.one_collection_field
    })
  }

  out.push(...BUILTIN)
  sourceCache = { at: Date.now(), sources: out }
  return out
}

const OPEN_EXISTS = (collection: string, idExpr: string) =>
  `EXISTS (SELECT 1 FROM nivaro_workflow_instances wi WHERE wi.collection = '${collection}' AND wi.completed_at IS NULL AND wi.item = CAST(${idExpr} AS NVARCHAR(255)))`

/** FROM/WHERE for one source, selecting alias `t` = the reported record and `u` = the account. */
function sourceSql(s: LinkSource): { from: string; where: string; idExpr: string } | null {
  if (s.kind === 'column') {
    return {
      from: `[${s.collection}] t JOIN nivaro_users u ON u.id = t.[${s.field}]`,
      where: s.scope === 'open' ? OPEN_EXISTS(s.collection, 't.id') : '1 = 1',
      idExpr: 't.id'
    }
  }
  if (s.kind === 'junction' && s.junction && s.parent_fk) {
    return {
      from: `[${s.junction}] j JOIN [${s.collection}] t ON t.id = j.[${s.parent_fk}] JOIN nivaro_users u ON u.id = j.[${s.field}]`,
      where: s.scope === 'open' ? OPEN_EXISTS(s.collection, 't.id') : '1 = 1',
      idExpr: 't.id'
    }
  }
  if (s.kind === 'm2a' && s.junction && s.parent_fk && s.discriminator) {
    return {
      from: `[${s.junction}] j JOIN [${s.collection}] t ON t.id = j.[${s.parent_fk}] JOIN nivaro_users u ON u.id = TRY_CONVERT(uniqueidentifier, j.[${s.field}])`,
      where: `j.[${s.discriminator}] IN ('directus_users', 'nivaro_users') AND ${s.scope === 'open' ? OPEN_EXISTS(s.collection, 't.id') : '1 = 1'}`,
      idExpr: 't.id'
    }
  }
  if (s.key === 'builtin:owner_seats') {
    return {
      from: 'nivaro_pipeline_owner_group_users m JOIN nivaro_pipeline_owner_groups t ON t.id = m.[group] JOIN nivaro_users u ON u.id = m.[user]',
      where: '1 = 1',
      idExpr: 't.id'
    }
  }
  if (s.key === 'builtin:teams') {
    return {
      from: 'nivaro_user_group_members m JOIN nivaro_user_groups t ON t.id = m.group_id JOIN nivaro_users u ON u.id = m.[user]',
      where: '1 = 1',
      idExpr: 't.id'
    }
  }
  if (s.key === 'builtin:instance_owners') {
    return {
      from: 'nivaro_pipeline_instance_owners o JOIN nivaro_workflow_instances t ON t.id = o.instance JOIN nivaro_users u ON u.id = o.[user]',
      where: 't.completed_at IS NULL',
      idExpr: 't.id'
    }
  }
  if (s.key === 'builtin:tasks') {
    return {
      from: 'nivaro_tasks t JOIN nivaro_users u ON u.id = t.assignee',
      where: `t.completed_at IS NULL AND (t.status IS NULL OR t.status NOT IN ('done', 'completed', 'cancelled'))`,
      idExpr: 't.id'
    }
  }
  return null
}

async function pooled<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

let scanCache: {
  at: number
  value: { sources: LinkSource[]; users: InactiveUserLinks[]; failed: string[] }
} | null = null

export function bustInactiveLinkCache() {
  scanCache = null
}

export async function scanInactiveUserLinks(opts: { fresh?: boolean } = {}) {
  if (!opts.fresh && scanCache && Date.now() - scanCache.at < 120_000) return scanCache.value
  const sources = await discoverLinkSources()
  const failed: string[] = []
  const perSource = await pooled(sources, 6, async (s) => {
    const q = sourceSql(s)
    if (!q) return [] as Array<{ user_id: string; n: number }>
    try {
      return (await db.raw(
        `SELECT CAST(u.id AS NVARCHAR(36)) AS user_id, COUNT(DISTINCT ${q.idExpr}) AS n FROM ${q.from} WHERE ${INACTIVE_SQL} AND ${q.where} GROUP BY u.id`
      )) as Array<{ user_id: string; n: number }>
    } catch {
      // A relation can outlive its table or column — report it, never fail the scan.
      failed.push(s.key)
      return []
    }
  })

  const byUser = new Map<string, Array<{ source: string; count: number }>>()
  perSource.forEach((rows, i) => {
    for (const r of rows) {
      const id = String(r.user_id).toUpperCase()
      const list = byUser.get(id) ?? []
      list.push({ source: sources[i].key, count: Number(r.n) })
      byUser.set(id, list)
    }
  })

  const ids = [...byUser.keys()]
  const rows = ids.length
    ? ((await selectInChunks(ids, 1500, (chunk) =>
        db('nivaro_users')
          .whereIn('id', chunk)
          .select('id', 'first_name', 'last_name', 'email', 'status', 'is_redacted', 'last_access')
      )) as Array<Record<string, unknown>>)
    : []
  const users: InactiveUserLinks[] = rows
    .map((u) => {
      const links = (byUser.get(String(u.id).toUpperCase()) ?? []).sort((a, b) => b.count - a.count)
      return {
        user: {
          id: String(u.id),
          name: [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.email ?? u.id),
          email: (u.email as string | null) ?? null,
          status: (u.status as string | null) ?? null,
          reason: reasonOf(u as { email?: string; is_redacted?: unknown }),
          last_access: u.last_access ? new Date(u.last_access as string).toISOString() : null
        },
        total: links.reduce((a, l) => a + l.count, 0),
        links
      }
    })
    .sort((a, b) => b.total - a.total)

  const value = {
    sources: sources.filter((s) => perSource[sources.indexOf(s)].length > 0),
    users,
    failed
  }
  scanCache = { at: Date.now(), value }
  return value
}

/** The records behind one (account, source) pair, labelled. */
export async function listInactiveUserRecords(userId: string, sourceKey: string, limit = 100) {
  const source = (await discoverLinkSources()).find((s) => s.key === sourceKey)
  const q = source ? sourceSql(source) : null
  if (!source || !q) return null
  const rows = (await db.raw(
    `SELECT DISTINCT TOP (?) CAST(${q.idExpr} AS NVARCHAR(255)) AS id FROM ${q.from} WHERE u.id = ? AND ${q.where} ORDER BY id DESC`,
    [Math.min(Math.max(limit, 1), 500), userId]
  )) as Array<{ id: string }>
  const ids = rows.map((r) => String(r.id))
  let labels: Record<string, string> = {}
  if (source.kind !== 'builtin') {
    labels = await getLabels(new Map([[source.collection, new Set(ids)]])).catch(() => ({}))
  } else if (ids.length) {
    const table = source.collection
    const col = table === 'nivaro_tasks' ? 'title' : 'name'
    if (table === 'nivaro_pipeline_instance_owners') {
      const inst = (await db('nivaro_workflow_instances')
        .whereIn('id', ids)
        .select('id', 'collection', 'item')) as Array<{
        id: string
        collection: string
        item: string
      }>
      const grouped = new Map<string, Set<string>>()
      for (const i of inst)
        grouped.set(i.collection, (grouped.get(i.collection) ?? new Set()).add(String(i.item)))
      const rec = await getLabels(grouped).catch(() => ({}) as Record<string, string>)
      return {
        source,
        records: inst.map((i) => ({
          id: String(i.item),
          collection: i.collection,
          label: rec[`${i.collection}:${i.item}`] ?? `${i.collection} ${i.item}`
        }))
      }
    }
    const named = (await db(table).whereIn('id', ids).select('id', col)) as Array<
      Record<string, unknown>
    >
    for (const n of named) labels[`${table}:${n.id}`] = String(n[col] ?? '') || `#${n.id}`
    if (table === 'nivaro_tasks') {
      const t = (await db('nivaro_tasks')
        .whereIn('id', ids)
        .select('id', 'collection', 'item', 'title')) as Array<{
        id: string
        collection: string
        item: string
        title: string
      }>
      return {
        source,
        records: t.map((x) => ({
          id: String(x.item),
          collection: x.collection,
          label: x.title,
          task_id: String(x.id)
        }))
      }
    }
  }
  return {
    source,
    records: ids.map((id) => ({
      id,
      collection: source.collection,
      label: labels[`${source.collection}:${id}`] ?? `#${id}`
    }))
  }
}

/**
 * Hand one account's records on a source to someone else. Every write goes
 * through the items service as the caller, so permissions, hooks, revisions
 * and change reasons apply. A junction link the successor already holds is
 * removed rather than duplicated.
 */
export async function reassignInactiveUserRecords(
  opts: { userId: string; sourceKey: string; to: string; ids?: string[]; reason: string },
  write: {
    update: (
      collection: string,
      id: string | number,
      data: Record<string, unknown>
    ) => Promise<unknown>
    remove: (collection: string, id: string | number) => Promise<unknown>
  }
) {
  const source = (await discoverLinkSources()).find((s) => s.key === opts.sourceKey)
  const q = source ? sourceSql(source) : null
  if (!source || !q || !source.reassignable) return null
  const only = opts.ids?.length ? new Set(opts.ids.map(String)) : null
  const result = { moved: 0, removed: 0, failed: [] as Array<{ id: string; error: string }> }

  if (source.kind === 'column') {
    const rows = (await db.raw(
      `SELECT DISTINCT TOP (500) CAST(t.id AS NVARCHAR(255)) AS id FROM ${q.from} WHERE u.id = ? AND ${q.where}`,
      [opts.userId]
    )) as Array<{ id: string }>
    for (const r of rows) {
      if (only && !only.has(String(r.id))) continue
      try {
        await write.update(source.collection, r.id, {
          [source.field]: opts.to,
          _change_reason: opts.reason
        })
        result.moved++
      } catch (e) {
        result.failed.push({ id: String(r.id), error: e instanceof Error ? e.message : String(e) })
      }
    }
  } else if (source.junction && source.parent_fk) {
    const userExpr =
      source.kind === 'm2a'
        ? `TRY_CONVERT(uniqueidentifier, j2.[${source.field}])`
        : `j2.[${source.field}]`
    const rows = (await db.raw(
      `SELECT TOP (500) j.id AS jid, CAST(t.id AS NVARCHAR(255)) AS id,
              CASE WHEN EXISTS (SELECT 1 FROM [${source.junction}] j2 WHERE j2.[${source.parent_fk}] = t.id AND ${userExpr} = ?) THEN 1 ELSE 0 END AS held
       FROM ${q.from} WHERE u.id = ? AND ${q.where}`,
      [opts.to, opts.userId]
    )) as Array<{ jid: number; id: string; held: number }>
    for (const r of rows) {
      if (only && !only.has(String(r.id))) continue
      try {
        if (Number(r.held) === 1) {
          await write.remove(source.junction, r.jid)
          result.removed++
        } else {
          await write.update(source.junction, r.jid, { [source.field]: opts.to })
          result.moved++
        }
      } catch (e) {
        result.failed.push({ id: String(r.id), error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  bustInactiveLinkCache()
  return { source, ...result }
}

// ─── Platform assignments: seats, teams, manual owners, tasks ────────────────

export interface PlatformEntry {
  /** The membership / owner / task ROW — what an action targets. */
  id: string
  title: string
  subtitle: string | null
  /** Facts shown beside the row, already worded. */
  facts: string[]
  /** Nobody else who can act holds this place. */
  sole: boolean
  others: string[]
  record: { collection: string; id: string; label: string } | null
  /** Admin console path for the thing itself (pipeline editor, team page). */
  console_path: string | null
}

const WORKING = `(w.status = 'active' AND (w.is_redacted = 0 OR w.is_redacted IS NULL))`
const personName = (r: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}) => [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? '')

/** 'project.project_type.name' reads as Project Type: the hop before the leaf names the thing. */
const dimensionLabel = (path: string) => {
  const parts = path.split('.')
  return titleCase(parts.length > 1 ? parts[parts.length - 2] : parts[0])
}

function filterSummary(raw: unknown): string | null {
  try {
    const f = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!f || typeof f !== 'object') return null
    // Two stored shapes: a list of {field, op, value} conditions, or a plain {field: value} map.
    const parts = Array.isArray(f)
      ? (f as Array<{ field?: string; op?: string; value?: unknown }>)
          .filter((c) => c?.field)
          .map(
            (c) =>
              `${dimensionLabel(String(c.field))}${c.op && c.op !== 'eq' ? ` ${c.op}` : ''}: ${Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')}`
          )
      : Object.entries(f as Record<string, unknown>)
          .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))
          .map(
            ([k, v]) =>
              `${dimensionLabel(k)}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`
          )
    return parts.length ? parts.join(' · ') : null
  } catch {
    return null
  }
}

/** The detail behind a platform source for one account — what each seat, place, owner row or task IS. */
export async function listPlatformEntries(
  userId: string,
  sourceKey: string
): Promise<PlatformEntry[] | null> {
  if (sourceKey === 'builtin:owner_seats') {
    const rows = (await db.raw(
      `SELECT TOP (500) m.id, g.id AS group_id, g.name, g.filters, g.is_default, g.template,
              tpl.name AS pipeline, st.label AS state_label,
              (SELECT COUNT(*) FROM nivaro_workflow_instances i WHERE i.current_state = g.state AND i.completed_at IS NULL) AS open_records,
              (SELECT COUNT(*) FROM nivaro_pipeline_owner_group_teams gt WHERE gt.[group] = g.id) AS teams
       FROM nivaro_pipeline_owner_group_users m
       JOIN nivaro_pipeline_owner_groups g ON g.id = m.[group]
       LEFT JOIN nivaro_workflow_templates tpl ON tpl.id = g.template
       LEFT JOIN nivaro_workflow_states st ON st.id = g.state
       WHERE m.[user] = ? ORDER BY tpl.name, st.sort, g.name`,
      [userId]
    )) as Array<Record<string, unknown>>
    const groupIds = rows.map((r) => r.group_id as number)
    const others = groupIds.length
      ? ((await selectInChunks(groupIds, 1500, (chunk) =>
          db('nivaro_pipeline_owner_group_users as m')
            .join('nivaro_users as w', 'w.id', 'm.user')
            .whereIn('m.group', chunk)
            .whereRaw(WORKING)
            .select('m.group as g', 'w.first_name', 'w.last_name', 'w.email')
        )) as Array<{
          g: number
          first_name: string | null
          last_name: string | null
          email: string | null
        }>)
      : []
    const byGroup = new Map<number, string[]>()
    for (const o of others) byGroup.set(o.g, [...(byGroup.get(o.g) ?? []), personName(o)])
    return rows.map((r) => {
      const peers = byGroup.get(r.group_id as number) ?? []
      const teams = Number(r.teams)
      return {
        id: String(r.id),
        title: `${r.pipeline ?? 'Pipeline'} · ${r.state_label ?? 'state'}`,
        subtitle:
          filterSummary(r.filters) ??
          (r.is_default ? 'Default group — every record' : (r.name as string | null)),
        facts: [
          `${Number(r.open_records).toLocaleString()} open in this state`,
          ...(teams ? [`${teams} team${teams === 1 ? '' : 's'} linked`] : [])
        ],
        sole: peers.length === 0 && teams === 0,
        others: peers,
        record: null,
        console_path: r.template ? `/pipelines/${r.template}` : null
      }
    })
  }
  if (sourceKey === 'builtin:teams') {
    const rows = (await db.raw(
      `SELECT m.id, t.id AS team_id, t.name, t.description,
              (SELECT COUNT(*) FROM nivaro_pipeline_owner_group_teams gt WHERE gt.team_id = t.id) AS cells
       FROM nivaro_user_group_members m JOIN nivaro_user_groups t ON t.id = m.group_id
       WHERE m.[user] = ? ORDER BY t.name`,
      [userId]
    )) as Array<Record<string, unknown>>
    const teamIds = rows.map((r) => r.team_id as number)
    const others = teamIds.length
      ? ((await db('nivaro_user_group_members as m')
          .join('nivaro_users as w', 'w.id', 'm.user')
          .whereIn('m.group_id', teamIds)
          .whereRaw(WORKING)
          .select('m.group_id as g', 'w.first_name', 'w.last_name', 'w.email')) as Array<{
          g: number
          first_name: string | null
          last_name: string | null
          email: string | null
        }>)
      : []
    const byTeam = new Map<number, string[]>()
    for (const o of others) byTeam.set(o.g, [...(byTeam.get(o.g) ?? []), personName(o)])
    return rows.map((r) => {
      const peers = byTeam.get(r.team_id as number) ?? []
      const cells = Number(r.cells)
      return {
        id: String(r.id),
        title: String(r.name ?? 'Team'),
        subtitle: (r.description as string | null) || null,
        facts: [
          cells
            ? `owns ${cells.toLocaleString()} matrix cell${cells === 1 ? '' : 's'}`
            : 'owns no matrix cells'
        ],
        sole: peers.length === 0,
        others: peers,
        record: null,
        console_path: '/teams'
      }
    })
  }
  if (sourceKey === 'builtin:instance_owners') {
    const rows = (await db.raw(
      `SELECT TOP (500) o.id, i.collection, i.item, st.label AS state_label, o.added_at,
              a.first_name, a.last_name, a.email
       FROM nivaro_pipeline_instance_owners o
       JOIN nivaro_workflow_instances i ON i.id = o.instance
       LEFT JOIN nivaro_workflow_states st ON st.id = o.state
       LEFT JOIN nivaro_users a ON a.id = o.added_by
       WHERE o.[user] = ? AND i.completed_at IS NULL ORDER BY o.added_at DESC`,
      [userId]
    )) as Array<Record<string, unknown>>
    const grouped = new Map<string, Set<string>>()
    for (const r of rows)
      grouped.set(
        String(r.collection),
        (grouped.get(String(r.collection)) ?? new Set()).add(String(r.item))
      )
    const labels = await getLabels(grouped).catch(() => ({}) as Record<string, string>)
    return rows.map((r) => {
      const label = labels[`${r.collection}:${r.item}`] || `#${r.item}`
      return {
        id: String(r.id),
        title: label,
        subtitle: `Owner for ${r.state_label ?? 'a state'}`,
        facts: [
          `added by ${personName(r as never) || 'someone'}${r.added_at ? ` on ${new Date(r.added_at as string).toISOString().slice(0, 10)}` : ''}`
        ],
        sole: false,
        others: [],
        record: { collection: String(r.collection), id: String(r.item), label },
        console_path: null
      }
    })
  }
  if (sourceKey === 'builtin:tasks') {
    const rows = (await db.raw(
      `SELECT TOP (500) t.id, t.title, t.collection, t.item, t.due_date, t.priority, t.status, t.created_at,
              a.first_name, a.last_name, a.email
       FROM nivaro_tasks t LEFT JOIN nivaro_users a ON a.id = t.created_by
       WHERE t.assignee = ? AND t.completed_at IS NULL AND (t.status IS NULL OR t.status NOT IN ('done', 'completed', 'cancelled'))
       ORDER BY t.due_date`,
      [userId]
    )) as Array<Record<string, unknown>>
    const grouped = new Map<string, Set<string>>()
    for (const r of rows)
      if (r.collection && r.item)
        grouped.set(
          String(r.collection),
          (grouped.get(String(r.collection)) ?? new Set()).add(String(r.item))
        )
    const labels = await getLabels(grouped).catch(() => ({}) as Record<string, string>)
    return rows.map((r) => {
      const due = r.due_date ? new Date(r.due_date as string) : null
      const label = r.collection ? labels[`${r.collection}:${r.item}`] || `#${r.item}` : ''
      return {
        id: String(r.id),
        title: String(r.title ?? 'Task'),
        subtitle: label ? `on ${label}` : null,
        facts: [
          due
            ? `${due.getTime() < Date.now() ? 'was due' : 'due'} ${due.toISOString().slice(0, 10)}`
            : 'no due date',
          `from ${personName(r as never) || 'someone'}`
        ],
        sole: false,
        others: [],
        record:
          r.collection && r.item
            ? { collection: String(r.collection), id: String(r.item), label }
            : null,
        console_path: null
      }
    })
  }
  return null
}

const PLATFORM: Record<
  string,
  { table: string; user: string; scope: string[]; removable: boolean }
> = {
  'builtin:owner_seats': {
    table: 'nivaro_pipeline_owner_group_users',
    user: 'user',
    scope: ['group'],
    removable: true
  },
  'builtin:teams': {
    table: 'nivaro_user_group_members',
    user: 'user',
    scope: ['group_id'],
    removable: true
  },
  'builtin:instance_owners': {
    table: 'nivaro_pipeline_instance_owners',
    user: 'user',
    scope: ['instance', 'state'],
    removable: true
  },
  'builtin:tasks': { table: 'nivaro_tasks', user: 'assignee', scope: [], removable: false }
}

/**
 * Replace or remove one account's platform assignments. A successor who
 * already holds the same place gets no second row — the old one is dropped.
 */
export async function actOnPlatformEntries(opts: {
  userId: string
  sourceKey: string
  action: 'replace' | 'remove'
  to?: string
  ids?: string[]
}) {
  const spec = PLATFORM[opts.sourceKey]
  if (!spec) return null
  if (opts.action === 'remove' && !spec.removable) return null
  if (opts.action === 'replace' && !opts.to) return null
  let q = db(spec.table).where(spec.user, opts.userId)
  if (opts.ids?.length) q = q.whereIn('id', opts.ids)
  const rows = (await q.select('*').limit(500)) as Array<Record<string, unknown>>
  const result = { moved: 0, removed: 0, failed: [] as Array<{ id: string; error: string }> }
  for (const r of rows) {
    try {
      if (opts.action === 'remove') {
        await db(spec.table)
          .where('id', r.id as number)
          .del()
        result.removed++
        continue
      }
      const held = spec.scope.length
        ? await db(spec.table)
            .where(spec.user, opts.to as string)
            .where(Object.fromEntries(spec.scope.map((c) => [c, r[c] as string | number])))
            .first('id')
        : null
      if (held) {
        await db(spec.table)
          .where('id', r.id as number)
          .del()
        result.removed++
      } else {
        await db(spec.table)
          .where('id', r.id as number)
          .update(
            spec.table === 'nivaro_tasks'
              ? { [spec.user]: opts.to, updated_at: new Date() }
              : { [spec.user]: opts.to }
          )
        result.moved++
      }
    } catch (e) {
      result.failed.push({ id: String(r.id), error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (opts.sourceKey === 'builtin:owner_seats' || opts.sourceKey === 'builtin:teams') {
    const { bustOwnerGroupCache } = await import('./pipeline-engine.js')
    bustOwnerGroupCache()
  }
  bustInactiveLinkCache()
  return { table: spec.table, ...result }
}
