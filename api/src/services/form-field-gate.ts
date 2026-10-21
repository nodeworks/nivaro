import { db } from '../db/index.js'
import {
  collectRecordConditionFields,
  fetchLayoutsForCollection,
  pickBestLayoutTraced
} from '../routes/collection-layouts.js'
import type { User } from '../types.js'
import { getFields, getRelations } from './collections.js'
import { selectInChunks } from './db-batch.js'
import { readItems } from './items.js'
import { getAllowedFields } from './permissions.js'

/**
 * #2722 — bulk "Update field" by form. The bulk bar offers only the fields on
 * the selected records' form, in its sections, and the server refuses a field
 * that form locks for the person — the same rules the record form draws:
 *
 * - a section locked for the person's role (`locked_for_roles`, admins exempt);
 * - a placement lock rule (`lock_conditions`): a listed role, or a pipeline
 *   step the record sits in now;
 * - a field marked read-only.
 *
 * Twin of the form's own evaluator (ItemEditForm `lockedFields`): change both.
 * Every record resolves its form the /active way (record rules → role →
 * default), in one candidates read and one record read per chunk.
 */

export interface GateGroup {
  id: number | null
  key: string
  label: string | null
  type: string | null
  sort: number
  container_id: number | null
  tab_mode: string | null
  hidden_for_roles: string | null
  locked_for_roles: string | null
  visibility_mode: string | null
}

export interface GatePlacement {
  field: string
  group_key: string | null
  sort: number
  label_override: string | null
  is_visible: boolean
  lock_conditions: string | null
}

export interface FormShape {
  layout_id: number
  name: string
  groups: GateGroup[]
  placements: GatePlacement[]
  ungrouped_sort: number | null
}

const up = (v: unknown) => String(v ?? '').toUpperCase()
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
const idKey = (v: unknown) => String(v).toLowerCase()

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map((x) => String(x)) : []
  } catch {
    return []
  }
}

interface LockCond {
  type?: string
  state_keys?: string[]
  role_ids?: string[]
}

function parseConds(raw: string | null | undefined): LockCond[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as LockCond[]) : []
  } catch {
    return []
  }
}

/**
 * The form as the person sees it on an existing record: sections hidden from
 * their role (and everything inside them) and new-record-only sections are
 * gone; placements turned off, slots and fields of a missing section too.
 */
export function visibleShape(shape: FormShape, roleId: string | null, isAdmin: boolean): FormShape {
  const role = roleId ? up(roleId) : null
  const byId = new Map<number, GateGroup>()
  for (const g of shape.groups) if (g.id != null) byId.set(g.id, g)
  const hiddenSelf = (g: GateGroup) =>
    g.visibility_mode === 'new_only' ||
    (!isAdmin && role != null && parseList(g.hidden_for_roles).some((r) => up(r) === role))
  const hidden = (g: GateGroup): boolean => {
    const seen = new Set<number>()
    let cur: GateGroup | undefined = g
    while (cur) {
      if (hiddenSelf(cur)) return true
      if (cur.container_id == null) return false
      if (seen.has(cur.container_id)) return false
      seen.add(cur.container_id)
      const parent = byId.get(cur.container_id)
      // A container the person cannot see takes its children with it.
      if (!parent) return true
      cur = parent
    }
    return false
  }
  const groups = shape.groups.filter((g) => !hidden(g))
  const keys = new Set(groups.map((g) => g.key))
  const placements = shape.placements.filter(
    (p) =>
      p.is_visible &&
      !p.field.startsWith('__') &&
      (p.group_key == null ||
        p.group_key === '__ungrouped__' ||
        p.group_key === '__header__' ||
        keys.has(p.group_key))
  )
  return { ...shape, groups, placements }
}

/**
 * Fields the form locks for the person on one record, with the reason in the
 * form's words. `currentState` is the record's pipeline step key (null = none).
 */
export function formLockedFields(input: {
  shape: FormShape
  roleId: string | null
  isAdmin: boolean
  currentState: string | null
  stateLabels?: Map<string, string>
  readonlyFields?: Set<string>
}): Map<string, string> {
  const out = new Map<string, string>()
  const role = input.roleId ? up(input.roleId) : null
  if (role && !input.isAdmin) {
    for (const g of input.shape.groups) {
      if (!parseList(g.locked_for_roles).some((r) => up(r) === role)) continue
      const label = g.label || g.key
      for (const p of input.shape.placements)
        if (p.group_key === g.key && !out.has(p.field))
          out.set(p.field, `The “${label}” section is locked for your role`)
    }
  }
  for (const p of input.shape.placements) {
    if (out.has(p.field)) continue
    for (const c of parseConds(p.lock_conditions)) {
      if (
        c.type === 'pipeline_state' &&
        Array.isArray(c.state_keys) &&
        input.currentState != null &&
        c.state_keys.includes(input.currentState)
      ) {
        const step = input.stateLabels?.get(input.currentState) ?? input.currentState
        out.set(p.field, `Locked while the record is in ${step}`)
        break
      }
      if (
        c.type === 'role' &&
        role != null &&
        Array.isArray(c.role_ids) &&
        c.role_ids.some((r) => up(r) === role)
      ) {
        out.set(p.field, 'Locked for your role on this form')
        break
      }
    }
  }
  if (input.readonlyFields)
    for (const p of input.shape.placements)
      if (!out.has(p.field) && input.readonlyFields.has(p.field))
        out.set(p.field, 'This field is read-only')
  return out
}

/** Whether any placement locks by pipeline step (only then are record steps read). */
export function usesStateLocks(shape: FormShape, fields?: Set<string>): boolean {
  return shape.placements.some(
    (p) =>
      (!fields || fields.has(p.field)) &&
      parseConds(p.lock_conditions).some(
        (c) => c.type === 'pipeline_state' && (c.state_keys?.length ?? 0) > 0
      )
  )
}

// ─── DB side ─────────────────────────────────────────────────────────────────

/** Each record's form (the /active resolution), keyed by lower-cased id. */
export async function resolveFormsForRecords(
  collection: string,
  ids: Array<string | number>,
  roleId: string | null,
  isAdmin: boolean
): Promise<Map<string, Record<string, unknown> | null>> {
  const out = new Map<string, Record<string, unknown> | null>()
  if (ids.length === 0) return out
  const layouts = (await fetchLayoutsForCollection(collection)) as Record<string, unknown>[]
  if (layouts.length === 0) {
    for (const id of ids) out.set(idKey(id), null)
    return out
  }
  // Same guards as resolveLayout: a registered collection, and only the
  // columns the candidates' record rules name.
  const registered = await db('nivaro_collections').where({ collection }).first()
  const columns = [...new Set(['id', ...collectRecordConditionFields(layouts)])]
  const rows = new Map<string, Record<string, unknown>>()
  if (registered && columns.length > 1) {
    const found = (await selectInChunks(ids, 1000, (chunk) =>
      db(collection)
        .whereIn('id', chunk)
        .select(columns)
        .catch(() => [] as Record<string, unknown>[])
    )) as Record<string, unknown>[]
    for (const r of found) rows.set(idKey(r.id), r)
  }
  const userRoleId = isAdmin ? null : roleId
  for (const id of ids) {
    const record = rows.get(idKey(id)) ?? (columns.length > 1 ? null : { id })
    out.set(idKey(id), pickBestLayoutTraced(layouts, userRoleId, record, isAdmin).row)
  }
  return out
}

/** A form's groups and placements, the parent filling what the child lacks (as /active). */
export async function loadFormShape(layout: Record<string, unknown>): Promise<FormShape> {
  const load = (id: number) =>
    Promise.all([
      db('nivaro_field_groups').where({ layout_id: id }).orderBy('sort', 'asc'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: id })
        .select('field', 'group_key', 'sort', 'label_override', 'is_visible', 'lock_conditions')
        .orderBy('sort', 'asc')
    ]) as Promise<[Record<string, unknown>[], Record<string, unknown>[]]>
  const id = Number(layout.id)
  let [g, a] = await load(id)
  if (layout.parent_layout_id) {
    try {
      const [pg, pa] = await load(Number(layout.parent_layout_id))
      const haveF = new Set(a.map((x) => String(x.field)))
      const haveG = new Set(g.map((x) => String(x.key)))
      a = [...a, ...pa.filter((x) => !haveF.has(String(x.field)))]
      g = [...g, ...pg.filter((x) => !haveG.has(String(x.key)))]
    } catch {
      // broken parent reference — the child stands alone
    }
  }
  const ungrouped = a.find((x) => x.field === '__ungrouped_pos__')
  return {
    layout_id: id,
    name: String(layout.name ?? `Form ${id}`),
    groups: g.map((x) => ({
      id: x.id == null ? null : Number(x.id),
      key: String(x.key),
      label: str(x.label),
      type: str(x.type),
      sort: Number(x.sort ?? 0),
      container_id: x.container_id == null ? null : Number(x.container_id),
      tab_mode: str(x.tab_mode),
      hidden_for_roles: str(x.hidden_for_roles),
      locked_for_roles: str(x.locked_for_roles),
      visibility_mode: str(x.visibility_mode)
    })),
    placements: a
      .filter((x) => x.field !== '__ungrouped_pos__')
      .map((x) => ({
        field: String(x.field),
        group_key: str(x.group_key),
        sort: Number(x.sort ?? 0),
        label_override: str(x.label_override),
        is_visible: x.is_visible == null ? true : !!x.is_visible,
        lock_conditions: str(x.lock_conditions)
      })),
    ungrouped_sort: ungrouped ? Number(ungrouped.sort) : null
  }
}

/** Pipeline step key per record (lower-cased id), only for the ids asked. */
async function recordStates(collection: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  try {
    const { attachRecordState } = await import('./record-state.js')
    const rows: Record<string, unknown>[] = ids.map((id) => ({ id }))
    await attachRecordState(collection, rows)
    for (const r of rows) {
      const s = r.$state as { key?: string } | null
      if (s?.key) out.set(idKey(r.id), s.key)
    }
  } catch {
    /* no pipeline read: no step locks */
  }
  return out
}

async function stateLabelsFor(shapes: FormShape[]): Promise<Map<string, string>> {
  const keys = new Set<string>()
  for (const s of shapes)
    for (const p of s.placements)
      for (const c of parseConds(p.lock_conditions)) for (const k of c.state_keys ?? []) keys.add(k)
  const out = new Map<string, string>()
  if (keys.size === 0) return out
  try {
    const rows = (await db('nivaro_workflow_states')
      .whereIn('key', [...keys])
      .select('key', 'label')) as Array<{ key: string; label: string | null }>
    for (const r of rows) if (!out.has(r.key) && r.label) out.set(r.key, r.label)
  } catch {
    /* labels are cosmetic */
  }
  return out
}

/** Fields a bulk write can set at all: real columns, not aliases or computed. */
export async function settableFields(collection: string): Promise<{
  settable: Set<string>
  readonly: Set<string>
  labels: Map<string, string>
}> {
  const [fields, rels] = await Promise.all([getFields(collection), getRelations(collection)])
  const alias = new Set(
    rels
      .filter((r) => r.one_collection === collection && r.one_field)
      .map((r) => String(r.one_field))
  )
  const settable = new Set<string>()
  const readonly = new Set<string>()
  const labels = new Map<string, string>()
  for (const f of fields) {
    if (f.field === 'id' || f.type === 'alias' || alias.has(f.field)) continue
    if (f.computed_formula) continue
    settable.add(f.field)
    if (f.readonly) readonly.add(f.field)
    const label = (f as { label?: string | null }).label
    if (label) labels.set(f.field, label)
  }
  return { settable, readonly, labels }
}

export interface FieldReport {
  /** Records whose form shows this field. */
  records: number
  /** Of those, records the form locks it on for this person. */
  locked: number
  reason: string | null
}

export interface BulkFieldsReport {
  /** Selected records the person can read (the rest are not counted). */
  readable: number
  /** Readable records with no form at all (the collection has none). */
  no_form: number
  forms: Array<FormShape & { records: number }>
  fields: Record<string, FieldReport>
}

/**
 * What the bulk bar offers for a selection, as the person: each readable
 * record's form, and per field how many of the records show it and how many
 * lock it. Only fields the person may update and a bulk write can set.
 */
export async function bulkFieldsReport(opts: {
  user: User
  isAdmin: boolean
  collection: string
  ids: Array<string | number>
  workspaceId?: string
}): Promise<BulkFieldsReport> {
  const { user, isAdmin, collection } = opts
  const res = (await readItems(
    user,
    collection,
    { fields: ['id'], filter: { id: { _in: opts.ids } }, limit: opts.ids.length, count: false },
    undefined,
    opts.workspaceId
  )) as { data?: Array<Record<string, unknown>> }
  const readableIds = (res.data ?? []).map((r) => String(r.id))
  const [forms, updatable, meta] = await Promise.all([
    resolveFormsForRecords(collection, readableIds, user.role ?? null, isAdmin),
    isAdmin ? Promise.resolve(null) : getAllowedFields(user, 'update', collection),
    settableFields(collection)
  ])
  const mayUpdate = (f: string) =>
    meta.settable.has(f) && (updatable == null || updatable.includes('*') || updatable.includes(f))

  const shapes = new Map<number, FormShape>()
  const recordsOf = new Map<number, string[]>()
  let noForm = 0
  for (const id of readableIds) {
    const row = forms.get(idKey(id))
    if (!row) {
      noForm++
      continue
    }
    const lid = Number(row.id)
    if (!shapes.has(lid))
      shapes.set(lid, visibleShape(await loadFormShape(row), user.role ?? null, isAdmin))
    const list = recordsOf.get(lid) ?? []
    list.push(id)
    recordsOf.set(lid, list)
  }
  const stateLabels = await stateLabelsFor([...shapes.values()])
  const needStates = [...shapes.entries()]
    .filter(([, s]) => usesStateLocks(s))
    .flatMap(([lid]) => recordsOf.get(lid) ?? [])
  const states = await recordStates(collection, needStates)

  const fields: Record<string, FieldReport> = {}
  for (const [lid, shape] of shapes) {
    const offered = shape.placements.filter((p) => mayUpdate(p.field))
    for (const id of recordsOf.get(lid) ?? []) {
      const locks = formLockedFields({
        shape,
        roleId: user.role ?? null,
        isAdmin,
        currentState: states.get(idKey(id)) ?? null,
        stateLabels,
        readonlyFields: meta.readonly
      })
      for (const p of offered) {
        const r = fields[p.field] ?? { records: 0, locked: 0, reason: null }
        r.records++
        const why = locks.get(p.field)
        if (why) {
          r.locked++
          r.reason = r.reason ?? why
        }
        fields[p.field] = r
      }
    }
  }
  // Records without a form offer every field the person may update.
  if (noForm > 0)
    for (const f of meta.settable) {
      if (!mayUpdate(f)) continue
      const r = fields[f] ?? { records: 0, locked: 0, reason: null }
      r.records += noForm
      if (meta.readonly.has(f)) {
        r.locked += noForm
        r.reason = r.reason ?? 'This field is read-only'
      }
      fields[f] = r
    }

  return {
    readable: readableIds.length,
    no_form: noForm,
    forms: [...shapes.values()]
      .map((s) => ({ ...s, records: recordsOf.get(s.layout_id)?.length ?? 0 }))
      .sort((a, b) => b.records - a.records),
    fields
  }
}

/**
 * The server half of #2722: per record, the reason a bulk write of `fields`
 * is refused — a field its form locks for the person, or (byForm) a field not
 * on its form. Records with no reason are absent. A record with no form is
 * judged by read-only marks only.
 */
export async function bulkFormRefusals(opts: {
  user: User
  isAdmin: boolean
  collection: string
  ids: Array<string | number>
  fields: string[]
  byForm: boolean
  workspaceId?: string
}): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { user, isAdmin, collection } = opts
  if (opts.fields.length === 0 || opts.ids.length === 0) return out
  // Only records the caller can read are judged: a refusal names the record's
  // form and its lock, which must never leak for a record they cannot see (or
  // confirm that it exists). The rest fail the usual way, as unreadable.
  const readable = await readableIds(user, collection, opts.ids, opts.workspaceId)
  const ids = opts.ids.filter((id) => readable.has(idKey(id)))
  if (ids.length === 0) return out
  const want = new Set(opts.fields)
  const [forms, meta] = await Promise.all([
    resolveFormsForRecords(collection, ids, user.role ?? null, isAdmin),
    settableFields(collection).catch(() => null)
  ])
  const readonly = new Set([...(meta?.readonly ?? [])].filter((f) => want.has(f)))
  const shapes = new Map<number, FormShape>()
  for (const row of forms.values()) {
    if (!row || shapes.has(Number(row.id))) continue
    shapes.set(Number(row.id), visibleShape(await loadFormShape(row), user.role ?? null, isAdmin))
  }
  const stateIds = ids
    .map((id) => String(id))
    .filter((id) => {
      const row = forms.get(idKey(id))
      return row ? usesStateLocks(shapes.get(Number(row.id)) as FormShape, want) : false
    })
  const [states, stateLabels] = await Promise.all([
    recordStates(collection, stateIds),
    stateLabelsFor([...shapes.values()])
  ])
  for (const id of ids) {
    const row = forms.get(idKey(id))
    const label = (f: string) => meta?.labels.get(f) ?? f
    if (!row) {
      const ro = opts.fields.find((f) => readonly.has(f))
      if (ro) out.set(idKey(id), `${label(ro)}: this field is read-only`)
      continue
    }
    const shape = shapes.get(Number(row.id)) as FormShape
    if (opts.byForm) {
      const on = new Set(shape.placements.map((p) => p.field))
      const off = opts.fields.find((f) => !on.has(f))
      if (off) {
        out.set(idKey(id), `${label(off)} is not on this record’s form (${shape.name})`)
        continue
      }
    }
    const locks = formLockedFields({
      shape,
      roleId: user.role ?? null,
      isAdmin,
      currentState: states.get(idKey(id)) ?? null,
      stateLabels,
      readonlyFields: readonly
    })
    const locked = opts.fields.find((f) => locks.has(f))
    if (locked) out.set(idKey(id), `${label(locked)}: ${locks.get(locked)}`)
    else {
      const ro = opts.fields.find((f) => readonly.has(f))
      if (ro) out.set(idKey(id), `${label(ro)}: this field is read-only`)
    }
  }
  return out
}

/** Lower-cased ids of `ids` the caller can read (RLS, scopes, workspace); none on a refusal. */
async function readableIds(
  user: User,
  collection: string,
  ids: Array<string | number>,
  workspaceId?: string
): Promise<Set<string>> {
  try {
    const rows = await selectInChunks(ids, 1000, async (chunk) => {
      const res = (await readItems(
        user,
        collection,
        { fields: ['id'], filter: { id: { _in: chunk } }, limit: chunk.length, count: false },
        undefined,
        workspaceId
      )) as { data?: Array<Record<string, unknown>> }
      return res.data ?? []
    })
    return new Set(rows.map((r) => idKey(r.id)))
  } catch {
    return new Set()
  }
}

export const bulkRefusalKey = idKey
