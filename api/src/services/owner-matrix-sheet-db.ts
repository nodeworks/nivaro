import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { chunkArray, selectInChunks } from './db-batch.js'
import {
  type FieldCatalog,
  fieldHeaders,
  type OwnerSheetContext,
  type SheetField,
  type SheetFilter,
  type SheetGroup,
  type SheetOps,
  type SheetPerson,
  type SheetState,
  type SheetTeam
} from './owner-matrix-sheet.js'
import { readOwnerMatrix, snapshotHash } from './owner-matrix-versions.js'
import { coerceBool, isInactivePerson, parseJson, toJsonStr } from './pipeline-engine.js'

// Database side of the owner-matrix spreadsheet (services/owner-matrix-sheet.ts):
// load the context (matrix, steps, filter fields, people, teams, value lists)
// and apply a plan's ops in one transaction.

/** Values read per filter field for the dropdowns; past it the list is cut
 *  and the sheet's own values are looked up one by one. */
const CATALOG_CAP = 5000

interface RelRow {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

/** Where a filter field's values live: the table + column (+ whether the
 *  value is on the bound collection itself, which carries no id_value).
 *  Same walk as pipeline-engine resolveFilterValues: an M2O chain, or an M2M
 *  alias through its junction. Null = the path does not resolve. */
async function fieldTarget(
  collection: string,
  field: string,
  knex: Knex
): Promise<{ table: string; column: string; self: boolean } | null> {
  const segs = field.split('.')
  const relCache = new Map<string, RelRow[]>()
  const relsFor = async (table: string) => {
    if (!relCache.has(table))
      relCache.set(
        table,
        (await knex('nivaro_relations')
          .where({ many_collection: table })
          .orWhere({ one_collection: table })
          .select(
            'many_collection',
            'many_field',
            'one_collection',
            'one_field',
            'junction_field'
          )) as RelRow[]
      )
    return relCache.get(table) ?? []
  }
  if (segs.length === 1) return { table: collection, column: field, self: true }
  if (segs.length > 4) return null
  const base = await relsFor(collection)
  const m2o = base.find(
    (r) => r.many_collection === collection && r.many_field === segs[0] && r.one_collection
  )
  if (m2o) {
    let table = m2o.one_collection as string
    for (let i = 1; i < segs.length - 1; i++) {
      const hop = (await relsFor(table)).find(
        (r) => r.many_collection === table && r.many_field === segs[i] && r.one_collection
      )
      if (!hop) return null
      table = hop.one_collection as string
    }
    return { table, column: segs[segs.length - 1], self: false }
  }
  const alias = base.find((r) => r.one_collection === collection && r.one_field === segs[0])
  if (alias?.junction_field && segs.length === 2) {
    const rel = (await relsFor(alias.many_collection)).find(
      (r) =>
        r.many_collection === alias.many_collection &&
        r.many_field === alias.junction_field &&
        r.one_collection
    )
    if (rel?.one_collection) return { table: rel.one_collection, column: segs[1], self: false }
  }
  return null
}

const lower = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

function addValue(cat: FieldCatalog, value: unknown, id: unknown) {
  const k = lower(value)
  if (!k) return
  const e = cat.values.get(k) ?? { value, ids: [] }
  if (id != null && !e.ids.some((x) => String(x) === String(id))) e.ids.push(id)
  cat.values.set(k, e)
}

async function loadCatalog(
  collection: string,
  field: string,
  knex: Knex
): Promise<FieldCatalog & { target?: { table: string; column: string; self: boolean } }> {
  const empty: FieldCatalog = { checkable: false, complete: false, self: false, values: new Map() }
  try {
    const target = await fieldTarget(collection, field, knex)
    if (!target) return empty
    // nivaro_relations is a claim: the table and column must really be there.
    if (!(await knex.schema.hasColumn(target.table, target.column))) return empty
    const cat: FieldCatalog = {
      checkable: true,
      complete: true,
      self: target.self,
      values: new Map()
    }
    if (target.self) {
      const rows = (await knex(target.table)
        .distinct(target.column)
        .whereNotNull(target.column)
        .limit(CATALOG_CAP + 1)) as Array<Record<string, unknown>>
      cat.complete = rows.length <= CATALOG_CAP
      for (const r of rows.slice(0, CATALOG_CAP)) addValue(cat, r[target.column], null)
    } else {
      const rows = (await knex(target.table)
        .select('id', target.column)
        .whereNotNull(target.column)
        .orderBy('id')
        .limit(CATALOG_CAP + 1)) as Array<Record<string, unknown>>
      cat.complete = rows.length <= CATALOG_CAP
      for (const r of rows.slice(0, CATALOG_CAP)) addValue(cat, r[target.column], r.id)
    }
    return { ...cat, target }
  } catch {
    return empty
  }
}

/** Everything the sheet needs about one pipeline's owner matrix. */
export async function loadOwnerSheetContext(
  templateId: string,
  knex: Knex = db
): Promise<(OwnerSheetContext & { lookUp: LookUp }) | null> {
  const template = (await knex('nivaro_workflow_templates')
    .where({ id: templateId })
    .first('id', 'name')) as { id: string; name: string } | undefined
  if (!template) return null

  const [stateRows, bindings, matrix] = await Promise.all([
    knex('nivaro_workflow_states')
      .where({ template: templateId })
      .orderBy('sort')
      .select('id', 'key', 'label', 'sort') as Promise<SheetState[]>,
    knex('nivaro_workflow_bindings')
      .where({ template: templateId })
      .orderBy('id')
      .select('id', 'collection') as Promise<Array<{ id: number; collection: string }>>,
    readOwnerMatrix(templateId, knex)
  ])
  const collectionOf = new Map(bindings.map((b) => [Number(b.id), b.collection]))
  const firstCollection = bindings[0]?.collection ?? ''

  // Dimensions: row axis first, then their own order; one column per field.
  const dims = [...matrix.dimensions]
    .filter((d) => collectionOf.has(Number(d.binding)))
    .sort(
      (a, b) =>
        Number(coerceBool(b.is_row_axis)) - Number(coerceBool(a.is_row_axis)) ||
        Number(a.sort ?? 0) - Number(b.sort ?? 0) ||
        Number(a.id) - Number(b.id)
    )
  const groups: SheetGroup[] = matrix.groups.map((g) => ({
    id: String(g.id),
    state: String(g.state),
    name: (g.name as string | null) ?? null,
    filters: ((parseJson(g.filters as string) as SheetFilter[] | null) ?? []).filter(
      (f) => f && typeof f.field === 'string'
    ),
    is_default: coerceBool(g.is_default),
    priority: Number(g.priority ?? 0) || 0,
    members: [],
    teams: []
  }))
  const byId = new Map(groups.map((g) => [g.id.toUpperCase(), g]))
  for (const m of matrix.members) byId.get(m.group)?.members.push(m.user)
  for (const t of matrix.teams) byId.get(t.group)?.teams.push(Number(t.team_id))

  const seen = new Set<string>()
  const fieldRows: Array<{
    field: string
    label: string | null
    collection: string
    required: boolean
    is_dimension: boolean
  }> = []
  for (const d of dims) {
    const field = String(d.field)
    if (seen.has(field)) continue
    seen.add(field)
    fieldRows.push({
      field,
      label: (d.label as string | null) ?? null,
      collection: collectionOf.get(Number(d.binding)) ?? firstCollection,
      required: coerceBool(d.required),
      is_dimension: true
    })
  }
  // Fields groups filter on that are no dimension: a column each, so their
  // values read as words too (and nothing is lost on the way back).
  const extra = new Set<string>()
  for (const g of groups)
    for (const f of g.filters)
      if (!seen.has(f.field) && f.op === 'eq' && f.value != null && typeof f.value !== 'object')
        extra.add(f.field)
  for (const field of [...extra].sort()) {
    seen.add(field)
    fieldRows.push({
      field,
      label: null,
      collection: firstCollection,
      required: false,
      is_dimension: false
    })
  }
  const headers = fieldHeaders(fieldRows)
  const fields: SheetField[] = fieldRows.map((f) => ({
    field: f.field,
    header: headers.get(f.field) ?? f.field,
    collection: f.collection,
    required: f.required,
    is_dimension: f.is_dimension
  }))

  const [catalogList, peopleRows, teamRows] = await Promise.all([
    Promise.all(fields.map((f) => loadCatalog(f.collection, f.field, knex))),
    knex('nivaro_users').select(
      'id',
      'email',
      'first_name',
      'last_name',
      'status',
      'is_redacted'
    ) as Promise<Array<Record<string, unknown>>>,
    knex('nivaro_user_groups')
      .select('id', 'name', 'slug')
      .catch(() => []) as Promise<Array<{ id: number; name: string; slug: string | null }>>
  ])
  const catalogs = new Map<string, FieldCatalog>()
  const targets = new Map<string, { table: string; column: string; self: boolean }>()
  fields.forEach((f, i) => {
    const { target, ...cat } = catalogList[i]
    catalogs.set(f.field, cat)
    if (target) targets.set(f.field, target)
  })
  const people: SheetPerson[] = peopleRows.map((p) => ({
    id: String(p.id),
    email: (p.email as string | null) ?? null,
    first_name: (p.first_name as string | null) ?? null,
    last_name: (p.last_name as string | null) ?? null,
    inactive: isInactivePerson(p as Parameters<typeof isInactivePerson>[0])
  }))
  const teams: SheetTeam[] = teamRows.map((t) => ({
    id: Number(t.id),
    name: String(t.name ?? ''),
    slug: t.slug ?? null
  }))

  // Values the sheet names that a cut-off list does not hold: read them by value.
  const lookUp: LookUp = async (wanted) => {
    for (const [field, values] of wanted) {
      const target = targets.get(field)
      const cat = catalogs.get(field)
      if (!target || !cat) continue
      const rows = (await selectInChunks(values, 500, (chunk) =>
        target.self
          ? knex(target.table).distinct(target.column).whereIn(target.column, chunk)
          : knex(target.table).select('id', target.column).whereIn(target.column, chunk)
      ).catch(() => [])) as Array<Record<string, unknown>>
      for (const r of rows) addValue(cat, r[target.column], target.self ? null : r.id)
    }
  }

  return {
    template: { id: String(template.id), name: String(template.name ?? '') },
    states: stateRows.map((s) => ({
      id: String(s.id),
      key: String(s.key ?? ''),
      label: String(s.label ?? s.key ?? ''),
      sort: Number(s.sort ?? 0)
    })),
    fields,
    groups,
    people,
    teams,
    catalogs,
    matrixHash: snapshotHash(JSON.stringify(matrix)),
    lookUp
  }
}

export type LookUp = (wanted: Map<string, string[]>) => Promise<void>

export class OwnerSheetStaleError extends Error {
  constructor() {
    super('The owner matrix changed since this preview')
  }
}

export interface OwnerSheetApplyResult {
  groups_added: number
  groups_removed: number
  groups_changed: number
  people_added: number
  people_removed: number
  teams_added: number
  teams_removed: number
  /** New group id per sheet row. */
  inserted: Array<{ row: number; id: string }>
}

/**
 * Write a plan's ops in ONE transaction. The matrix is read again inside it
 * and must still hash to `matrixHash` (what the preview was computed on) —
 * otherwise OwnerSheetStaleError and nothing is written.
 */
export async function applyOwnerSheetOps(
  templateId: string,
  matrixHash: string,
  ops: SheetOps,
  knex: Knex = db
): Promise<OwnerSheetApplyResult> {
  const result: OwnerSheetApplyResult = {
    groups_added: 0,
    groups_removed: 0,
    groups_changed: 0,
    people_added: 0,
    people_removed: 0,
    teams_added: 0,
    teams_removed: 0,
    inserted: []
  }
  await knex.transaction(async (trx) => {
    const live = await readOwnerMatrix(templateId, trx)
    if (snapshotHash(JSON.stringify(live)) !== matrixHash) throw new OwnerSheetStaleError()

    for (const chunk of chunkArray(ops.deletes, 500)) {
      result.people_removed += await trx('nivaro_pipeline_owner_group_users')
        .whereIn('group', chunk)
        .delete()
      result.teams_removed += await trx('nivaro_pipeline_owner_group_teams')
        .whereIn('group', chunk)
        .delete()
      result.groups_removed += await trx('nivaro_pipeline_owner_groups')
        .whereIn('id', chunk)
        .where({ template: templateId })
        .delete()
    }

    const groupRows: Array<Record<string, unknown>> = []
    const memberRows: Array<{ group: string; user: string }> = []
    const teamRows: Array<{ group: string; team_id: number }> = []
    for (const ins of ops.inserts) {
      const id = randomUUID()
      result.inserted.push({ row: ins.row, id })
      groupRows.push({
        id,
        template: templateId,
        state: ins.state,
        name: ins.name,
        filters: ins.filters.length ? toJsonStr(ins.filters) : null,
        is_default: ins.is_default ? 1 : 0,
        sort: 0,
        priority: ins.priority
      })
      for (const user of ins.users) memberRows.push({ group: id, user })
      for (const team_id of ins.teams) teamRows.push({ group: id, team_id })
    }
    for (const chunk of chunkArray(groupRows, 100)) {
      await trx('nivaro_pipeline_owner_groups').insert(chunk)
      result.groups_added += chunk.length
    }

    for (const u of ops.updates) {
      const set: Record<string, unknown> = {}
      if (u.set.state !== undefined) set.state = u.set.state
      if (u.set.name !== undefined) set.name = u.set.name
      if (u.set.filters !== undefined)
        set.filters = u.set.filters.length ? toJsonStr(u.set.filters) : null
      if (u.set.is_default !== undefined) set.is_default = u.set.is_default ? 1 : 0
      if (u.set.priority !== undefined) set.priority = u.set.priority
      if (Object.keys(set).length)
        await trx('nivaro_pipeline_owner_groups')
          .where({ id: u.id, template: templateId })
          .update(set)
      for (const chunk of chunkArray(u.remove_users, 500))
        result.people_removed += await trx('nivaro_pipeline_owner_group_users')
          .where({ group: u.id })
          .whereIn('user', chunk)
          .delete()
      for (const chunk of chunkArray(u.remove_teams, 500))
        result.teams_removed += await trx('nivaro_pipeline_owner_group_teams')
          .where({ group: u.id })
          .whereIn('team_id', chunk)
          .delete()
      for (const user of u.add_users) memberRows.push({ group: u.id, user })
      for (const team_id of u.add_teams) teamRows.push({ group: u.id, team_id })
      result.groups_changed++
    }

    for (const chunk of chunkArray(memberRows, 500)) {
      await trx('nivaro_pipeline_owner_group_users').insert(chunk)
      result.people_added += chunk.length
    }
    for (const chunk of chunkArray(teamRows, 500)) {
      await trx('nivaro_pipeline_owner_group_teams').insert(chunk)
      result.teams_added += chunk.length
    }
  })
  return result
}
