/**
 * Fields an addendum MUST change (prod 2026-11-24, workflow 368943: an addendum whose lines
 * matched the record's went to review and the approver had nothing to approve).
 *
 * An addendum layout marks a field with the assignment override `require_change: true`
 * (layout editor → Rules → "Must change"). POST /api/addendums and a draft's PATCH refuse a
 * proposal that leaves such a field as the record has it: 422 ADDENDUM_NO_CHANGE naming the
 * fields. A line table (plain O2M) changes when approval would add, change or remove a row
 * (planLineOps against the lines as they are now); any other field when its proposed value
 * differs from the record's (sameValue). The client sheet applies the same rule first
 * (packages/shared addendum-draft.ts) — this is the gate.
 */
import { db } from '../db/index.js'
import { addendumLineLinks, planLineOps, sameValue } from './addendum-lines.js'

type Row = Record<string, unknown>

const parseOverrides = (raw: unknown): Row => {
  if (raw && typeof raw === 'object') return raw as Row
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Row) : {}
  } catch {
    return {}
  }
}

const titleLabel = (f: string) => {
  const s = f.replace(/_/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : f
}

/** The layout's fields marked "must change", with the label the form shows. */
export async function requiredChangeFields(
  layoutId: number | null | undefined
): Promise<Array<{ field: string; label: string }>> {
  if (!layoutId) return []
  const rows = (await db('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .select('field', 'overrides', 'label_override')) as Array<{
    field: string
    overrides: unknown
    label_override: string | null
  }>
  return rows
    .filter((r) => !r.field.startsWith('__') && parseOverrides(r.overrides).require_change === true)
    .map((r) => ({ field: r.field, label: r.label_override?.trim() || titleLabel(r.field) }))
}

/** Pure: does this proposal change the field? Lines by the approval plan, the rest by value. */
export function fieldChanged(
  field: string,
  data: Row | null | undefined,
  parent: Row,
  lines: { current: Row[]; fk: string; writable: Set<string> } | null
): boolean {
  const proposed = data?.[field]
  if (lines) {
    if (!Array.isArray(proposed)) return false
    const ops = planLineOps(
      proposed as Row[],
      lines.current,
      lines.current,
      lines.fk,
      lines.writable
    )
    return ops.creates.length + ops.updates.length + ops.deletes.length > 0
  }
  if (!data || !(field in data) || proposed === undefined) return false
  return !sameValue(proposed, parent[field])
}

/**
 * The required fields this proposal leaves unchanged (empty = fine). Reads the record and its
 * lines as they are now.
 */
export async function missingRequiredChanges(
  parentCollection: string,
  parentId: string,
  layoutId: number | null | undefined,
  data: Row | null | undefined
): Promise<Array<{ field: string; label: string }>> {
  const required = await requiredChangeFields(layoutId)
  if (required.length === 0) return []
  const links = new Map((await addendumLineLinks(parentCollection, data)).map((l) => [l.alias, l]))
  const lineRelations = new Map(
    (
      (await db('nivaro_relations')
        .where({ one_collection: parentCollection })
        .whereIn(
          'one_field',
          required.map((r) => r.field)
        )
        .whereNull('junction_field')
        .select('one_field', 'many_collection', 'many_field')) as Array<{
        one_field: string
        many_collection: string | null
        many_field: string | null
      }>
    ).map((r) => [r.one_field, r])
  )
  let parent: Row | null = null
  const missing: Array<{ field: string; label: string }> = []
  for (const r of required) {
    const rel = lineRelations.get(r.field)
    if (rel?.many_collection && rel.many_field) {
      // A line table the proposal does not carry (or carries in a shape addendumLineLinks
      // refuses) changes nothing.
      const link = links.get(r.field)
      if (!link) {
        missing.push(r)
        continue
      }
      const current = (await db(link.collection).where(link.fk, parentId).select('*')) as Row[]
      const writable = new Set(Object.keys(await db(link.collection).columnInfo()))
      if (!fieldChanged(r.field, data, {}, { current, fk: link.fk, writable })) missing.push(r)
      continue
    }
    if (!parent)
      parent =
        ((await db(parentCollection).where({ id: parentId }).first()) as Row | undefined) ?? {}
    if (!fieldChanged(r.field, data, parent, null)) missing.push(r)
  }
  return missing
}

/** The refusal both routes answer with. */
export function noChangeRefusal(missing: Array<{ field: string; label: string }>) {
  const names = missing.map((m) => m.label).join(', ')
  return {
    error: `This addendum must change ${names}. Nothing there differs from the record yet.`,
    code: 'ADDENDUM_NO_CHANGE',
    fields: missing.map((m) => m.field)
  }
}
