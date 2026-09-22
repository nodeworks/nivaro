/**
 * Owner-group filter shapes (#514).
 *
 * `nivaro_pipeline_owner_groups.filters` is stored one of two ways — a LIST
 * `[{field, op, value, id_value?}]` (what the legacy owner sync and the
 * matrix write) or a MAP `{field: value}` (older hand-made rows). Both name
 * the dimension by its dotted FIELD; nothing is positional. This module is
 * the one reader every consumer of the raw column should go through, and the
 * readiness check flags a filter whose field matches no dimension on the
 * group's binding — the config that CANNOT match a record and silently
 * leaves it unowned.
 */
import { db } from '../db/index.js'

export interface OwnerFilterEntry {
  field: string
  op: string
  value: unknown
  id_value?: unknown
}

export function ownerFilterEntries(raw: unknown): OwnerFilterEntry[] {
  if (raw == null) return []
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  if (Array.isArray(v)) {
    return v
      .filter(
        (e) => e && typeof e === 'object' && typeof (e as { field?: unknown }).field === 'string'
      )
      .map((e) => {
        const o = e as Record<string, unknown>
        return {
          field: String(o.field),
          op: String(o.op ?? 'eq'),
          value: o.value,
          id_value: o.id_value
        }
      })
  }
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !/^\d+$/.test(k)) // a numeric key would BE the positional mistake
      .map(([field, val]) => {
        const inner =
          val !== null && typeof val === 'object'
            ? (val as { value?: unknown; op?: unknown })
            : null
        return { field, op: String(inner?.op ?? 'eq'), value: inner ? inner.value : val }
      })
  }
  return []
}

export interface OwnerFilterFinding {
  group_id: string
  group_name: string | null
  template: string
  state: string
  kind: 'unknown_field' | 'unparseable' | 'positional'
  detail: string
}

/** Every owner group whose filters cannot match a record on its binding's dimensions. */
export async function lintOwnerFilters(): Promise<{
  groups: number
  findings: OwnerFilterFinding[]
}> {
  const groups = (await db('nivaro_pipeline_owner_groups as g')
    .join('nivaro_workflow_states as s', 's.id', 'g.state')
    .select('g.id', 'g.name', 'g.filters', 's.template', 's.key as state_key')
    .whereNotNull('g.filters')) as Array<{
    id: string
    name: string | null
    filters: string
    template: string
    state_key: string
  }>
  const dims = (await db('nivaro_pipeline_owner_dimensions as d')
    .join('nivaro_workflow_bindings as b', 'b.id', 'd.binding')
    .select('b.template', 'd.field')) as Array<{ template: string; field: string }>
  const fieldsByTemplate = new Map<string, Set<string>>()
  for (const d of dims) {
    const k = String(d.template).toUpperCase()
    const set = fieldsByTemplate.get(k) ?? new Set<string>()
    set.add(d.field)
    fieldsByTemplate.set(k, set)
  }
  const findings: OwnerFilterFinding[] = []
  for (const g of groups) {
    let parsed: unknown
    try {
      parsed = JSON.parse(g.filters)
    } catch {
      findings.push({
        group_id: g.id,
        group_name: g.name,
        template: g.template,
        state: g.state_key,
        kind: 'unparseable',
        detail: g.filters.slice(0, 80)
      })
      continue
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).some((k) => /^\d+$/.test(k))
    ) {
      findings.push({
        group_id: g.id,
        group_name: g.name,
        template: g.template,
        state: g.state_key,
        kind: 'positional',
        detail: `numeric keys ${Object.keys(parsed).join(',')}`
      })
      continue
    }
    const known = fieldsByTemplate.get(String(g.template).toUpperCase())
    if (!known) continue
    for (const e of ownerFilterEntries(parsed)) {
      if (!known.has(e.field))
        findings.push({
          group_id: g.id,
          group_name: g.name,
          template: g.template,
          state: g.state_key,
          kind: 'unknown_field',
          detail: `${e.field} is not a dimension on this template (${[...known].join(', ')})`
        })
    }
  }
  return { groups: groups.length, findings }
}
