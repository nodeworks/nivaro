/**
 * Army 11 N3 (2026-11-08): bulk "Update field" runs the record form's own field
 * rules, server-side, for every caller (admins included — these are about the
 * record's shape, not rank). One click had emptied a required Description and
 * given a workflow a Project Type that did not match its Project / Sub Type,
 * renumbering it MM26-81442 → CR26-81442.
 *
 * - Required: a field the form requires (the field's own mark, or an active
 *   form's placement that requires it) is never cleared in bulk.
 * - Cascade parents: a field other fields' pickers are narrowed by (Zone,
 *   Project Type, Project …) is never changed in bulk — on the form a change
 *   there re-checks and clears its children; a bulk write cannot.
 * - Sequenced ids: a field an auto id with a running number is built from
 *   (the PW/MM/CR prefix of a workflow id) is never changed in bulk — the id
 *   people quote would silently change.
 * - Cascade children: a value is judged per record against that record's
 *   parents, exactly as the form's picker narrows it (picker-rules.ts).
 *
 * The bulk bar reads the same verdicts (form-field-gate.ts bulkFieldsReport)
 * so it never offers what this refuses.
 */
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { type CascadeRule, cascadeValueRefusal, pickerAliases } from './picker-rules.js'

export interface BulkRuleField {
  field: string
  label: string
  required: boolean
  /** Labels of the fields whose picker this one narrows. */
  dependents: string[]
  /** Label of the sequenced id this field is part of, if any. */
  idField: string | null
  cascades: CascadeRule[]
  /** The linked collection of a many-to-one field. */
  target: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function parse<T>(raw: unknown): T | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

export const emptyBulkValue = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0) ||
  // A to-many Replace with nothing picked takes every link off (2026-11-13).
  (typeof v === 'object' &&
    !Array.isArray(v) &&
    Array.isArray((v as { set?: unknown }).set) &&
    (v as { set: unknown[] }).set.length === 0)

const words = (field: string) => {
  const w = field
    .replace(/^(is|has)_/, '')
    .replace(/_/g, ' ')
    .trim()
  return w ? w[0].toUpperCase() + w.slice(1) : field
}

/** The fields an auto-id pattern is built from (`{project_type.short_code}` → project_type). */
export function patternFields(pattern: string): string[] {
  const out = new Set<string>()
  for (const m of pattern.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/g))
    if (m[1] !== 'seq') out.add(m[1])
  return [...out]
}

interface FieldRow {
  field: string
  label: string | null
  required: unknown
  options: unknown
  dependency_config: unknown
}

/** Pure: the per-field rule table from the collection's field rows. */
export function buildRuleTable(
  rows: FieldRow[],
  targets: Map<string, string>,
  formRequired: Set<string> = new Set()
): Map<string, BulkRuleField> {
  const out = new Map<string, BulkRuleField>()
  const labelOf = (f: string) => {
    const r = rows.find((x) => x.field === f)
    return String(r?.label ?? '').trim() || words(f)
  }
  for (const r of rows)
    out.set(r.field, {
      field: r.field,
      label: labelOf(r.field),
      required:
        r.required === true || r.required === 1 || r.required === '1' || formRequired.has(r.field),
      dependents: [],
      idField: null,
      cascades: [],
      target: targets.get(r.field) ?? null
    })
  for (const r of rows) {
    const dep = parse<{ cascade_filters?: CascadeRule[] }>(r.dependency_config)
    const cascades = (dep?.cascade_filters ?? []).filter(
      (c) =>
        typeof c?.parent_field === 'string' &&
        typeof c?.filter_column === 'string' &&
        IDENT.test(c.parent_field) &&
        c.filter_column.split('.').every((s) => IDENT.test(s))
    )
    const me = out.get(r.field)
    if (me) me.cascades = cascades
    for (const c of cascades) {
      if (c.parent_field === r.field) continue
      const parent = out.get(c.parent_field)
      const name = labelOf(r.field)
      if (parent && !parent.dependents.includes(name)) parent.dependents.push(name)
    }
    const auto = parse<{
      auto_id?: {
        pattern?: unknown
        variants?: Array<{ pattern?: unknown; when?: { field?: unknown } }>
      }
    }>(r.options)?.auto_id
    if (!auto) continue
    const patterns = [auto.pattern, ...(auto.variants ?? []).map((v) => v?.pattern)].filter(
      (p): p is string => typeof p === 'string'
    )
    // Only a sequenced id ({seq}) is a number people quote; a built name is not.
    if (!patterns.some((p) => p.includes('{seq}'))) continue
    const feeders = new Set(patterns.flatMap(patternFields))
    for (const v of auto.variants ?? [])
      if (typeof v?.when?.field === 'string') feeders.add(v.when.field)
    for (const f of feeders) {
      const feeder = out.get(f)
      if (feeder && f !== r.field && !feeder.idField) feeder.idField = labelOf(r.field)
    }
  }
  return out
}

const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/** Pure: why `value` may not be written to this field in bulk (any record), or null. */
export function bulkFieldRefusal(rule: BulkRuleField | undefined, value: unknown): string | null {
  if (!rule) return null
  if (rule.required && emptyBulkValue(value))
    return `${rule.label} is required — it can’t be left empty`
  if (rule.dependents.length > 0)
    return `${rule.label} decides what ${list(rule.dependents)} can be — change it on each record’s form`
  if (rule.idField)
    return `${rule.label} is part of each record’s ${rule.idField} — changing it here would renumber them`
  return null
}

/** Pure: the lock a field carries on the bulk bar whatever value is picked (required is not one). */
export function bulkFieldLock(rule: BulkRuleField | undefined): string | null {
  if (!rule) return null
  if (rule.dependents.length > 0 || rule.idField) return bulkFieldRefusal(rule, '__any__')
  return null
}

/** The collection's rule table (field rows, many-to-one targets). */
export async function bulkRuleTable(collection: string): Promise<Map<string, BulkRuleField>> {
  const [rows, rels] = await Promise.all([
    db('nivaro_fields')
      .where({ collection })
      .select('field', 'label', 'required', 'options', 'dependency_config') as Promise<FieldRow[]>,
    (
      db('nivaro_relations')
        .where({ many_collection: collection })
        .whereNull('junction_field')
        .select('many_field', 'one_collection') as Promise<
        Array<{ many_field: string; one_collection: string | null }>
      >
    ).catch(() => [])
  ])
  const targets = new Map<string, string>()
  for (const r of rels) if (r.one_collection) targets.set(r.many_field, r.one_collection)
  return buildRuleTable(rows, targets)
}

/** Does this form's placement of `field` require it (overrides.required === true)? Pure. */
export function placementRequires(
  placements: Array<{ field: string; overrides?: string | null }>,
  field: string
): boolean {
  const p = placements.find((x) => x.field === field)
  return parse<{ required?: unknown }>(p?.overrides)?.required === true
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

const CHUNK = 500

/**
 * Per record (lower-cased id → reason), the bulk write of `data` the form's
 * rules refuse. Only records the caller can read are judged — a refusal
 * names a record's parents and form, which must never leak for a record they
 * cannot open (the rest fail later as not found). Static refusals apply to
 * every readable record; "required" is judged against each record's own form;
 * a cascade child's value is judged once per distinct set of parent values,
 * the rows read in chunks, a few judgements at a time.
 */
export async function bulkRuleRefusals(opts: {
  collection: string
  ids: Array<string | number>
  data: Record<string, unknown>
  user: User
  isAdmin: boolean
  workspaceId?: string
}): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const fields = Object.keys(opts.data).filter((k) => !k.startsWith('_'))
  if (fields.length === 0 || opts.ids.length === 0) return out
  const table = await bulkRuleTable(opts.collection)
  // Nothing this write could refuse: no read of the records at all.
  const anyRule = fields.some((f) => {
    const r = table.get(f)
    return (
      !!r &&
      (r.dependents.length > 0 ||
        !!r.idField ||
        emptyBulkValue(opts.data[f]) ||
        (!!r.target && r.cascades.length > 0))
    )
  })
  if (!anyRule) return out
  const { readableIds } = await import('./form-field-gate.js')
  const readable = await readableIds(opts.user, opts.collection, opts.ids, opts.workspaceId)
  const ids = opts.ids.filter((id) => readable.has(String(id).toLowerCase()))
  if (ids.length === 0) return out
  const key = (id: string | number) => String(id).toLowerCase()
  const refuseAll = (why: string, among: Array<string | number> = ids) => {
    for (const id of among) if (!out.has(key(id))) out.set(key(id), why)
  }

  for (const f of fields) {
    const rule = table.get(f)
    if (!rule) continue
    const lock = bulkFieldLock(rule)
    if (lock) refuseAll(lock)
    else if (rule.required && emptyBulkValue(opts.data[f]))
      refuseAll(bulkFieldRefusal(rule, opts.data[f]) as string)
  }
  if (out.size === ids.length) return out

  // Required on the record's OWN form (a placement that requires the field).
  const cleared = fields.filter((f) => table.has(f) && emptyBulkValue(opts.data[f]))
  if (cleared.length > 0) {
    const { resolveFormsForRecords, loadFormShape } = await import('./form-field-gate.js')
    const forms = await resolveFormsForRecords(
      opts.collection,
      ids,
      opts.user.role ?? null,
      opts.isAdmin,
      opts.user.id ? String(opts.user.id) : null
    )
    const shapes = new Map<number, Awaited<ReturnType<typeof loadFormShape>>>()
    for (const id of ids) {
      const form = forms.get(key(id))
      if (!form) continue
      const lid = Number(form.id)
      if (!shapes.has(lid)) shapes.set(lid, await loadFormShape(form))
      const shape = shapes.get(lid)
      const f = cleared.find((x) => shape && placementRequires(shape.placements, x))
      if (f && !out.has(key(id)))
        out.set(
          key(id),
          `${table.get(f)?.label ?? f} is required on this record’s form — it can’t be left empty`
        )
    }
  }

  const parentLabels = Object.fromEntries([...table.values()].map((r) => [r.field, r.label]))
  let columns: Set<string> | null = null
  for (const f of fields) {
    const rule = table.get(f)
    if (!rule?.target || rule.cascades.length === 0) continue
    const value = opts.data[f]
    if (emptyBulkValue(value) || typeof value === 'object') continue
    const open = ids.filter((id) => !out.has(key(id)))
    if (open.length === 0) break
    columns ??= new Set(
      Object.keys(
        (await db(opts.collection)
          .columnInfo()
          .catch(() => ({}))) as Record<string, unknown>
      )
    )
    const parents = [...new Set(rule.cascades.map((c) => c.parent_field))].filter((p) =>
      IDENT.test(p)
    )
    const colParents = parents.filter((p) => columns?.has(p))
    // Each record's parent values: its columns, then its many-to-many links.
    const rows = new Map<string, Record<string, unknown>>()
    const found = await selectInChunks(open, CHUNK, (chunk) =>
      whereInList(db(opts.collection), 'id', chunk)
        .select(['id', ...colParents])
        .catch(() => [] as Array<Record<string, unknown>>)
    )
    const asked = new Set(open.map(key))
    for (const r of found as Array<Record<string, unknown>>)
      if (asked.has(key(r.id as string))) rows.set(key(r.id as string), { ...r })
    const linkParents = parents.filter((p) => !columns?.has(p))
    if (linkParents.length > 0) {
      const aliases = await pickerAliases(opts.collection)
      for (const p of linkParents) {
        const a = aliases.get(p)
        if (!a) continue
        const links = await selectInChunks(open, CHUNK, (chunk) =>
          whereInList(db(a.junction), a.parentFk, chunk)
            .select(a.parentFk, a.targetFk)
            .catch(() => [] as Array<Record<string, unknown>>)
        )
        for (const r of rows.values()) r[p] = []
        for (const l of links as Array<Record<string, unknown>>) {
          const row = rows.get(key(l[a.parentFk] as string))
          const v = l[a.targetFk]
          if (row && v != null) (row[p] as unknown[]).push(v)
        }
        for (const r of rows.values()) (r[p] as unknown[]).sort()
      }
    }
    // One judgement per distinct set of parent values.
    const groups = new Map<string, { row: Record<string, unknown>; ids: string[] }>()
    for (const [id, row] of rows) {
      const tuple = JSON.stringify(parents.map((p) => row[p] ?? null))
      const g = groups.get(tuple) ?? { row, ids: [] }
      g.ids.push(id)
      groups.set(tuple, g)
    }
    await pool([...groups.values()], 4, async (g) => {
      const why = await cascadeValueRefusal({
        collection: opts.collection,
        id: g.ids[0],
        label: rule.label,
        target: rule.target as string,
        cascades: rule.cascades,
        value,
        row: g.row,
        parentLabels
      })
      if (why) for (const id of g.ids) if (!out.has(id)) out.set(id, why)
    })
  }
  return out
}
