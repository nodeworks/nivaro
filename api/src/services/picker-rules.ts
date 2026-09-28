/**
 * Picker rules enforced on write.
 *
 * A relation picker on the record form narrows its options three ways:
 *   cascade filters   the field's `dependency_config.cascade_filters`, judged
 *                     against the record's parent fields (a project of the
 *                     chosen zone and funding year)
 *   option_filter     the field's own static filter, `$parent.<field>` tokens
 *                     read off the record
 *   picker_filter     the TARGET collection's picker curation
 * plus the target's per-record picker exclusions. All of that was judged in
 * the browser only: a write through the API, an import or a script could
 * store a value the form would never offer. A field whose options carry
 * `enforce_picker_rules: true` (on the field, or on its assignment in the
 * collection's active grouped layout) is judged on every write too.
 *
 * Opt-in on purpose: integrations write legacy combinations the form no
 * longer offers, and a rule enforced on the field binds every writer. Only
 * fields present in the caller's payload are judged, with the row as it
 * would be stored.
 *
 * This module must not import the items service at load time (the items
 * service calls it); the filter compiler is imported when first needed.
 */
import { db } from '../db/index.js'

interface CascadeRule {
  parent_field: string
  filter_column: string
  filter_is_m2m?: boolean
  filter_via_many?: boolean
  value_map?: Record<string, unknown>
  value_map_default?: unknown
  show_all_if_no_parent?: boolean
}

interface Rule {
  collection: string
  field: string
  label: string
  target: string
  cascades: CascadeRule[]
  optionFilter: Record<string, unknown> | null
  pickerFilter: Record<string, unknown> | null
}

/** A many-to-many alias on the parent collection, read for a parent field the
 *  payload does not carry (an update that only moves the child). */
interface Alias {
  junction: string
  parentFk: string
  targetFk: string
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const TTL = 60_000
let cache: { at: number; byCollection: Map<string, Rule[]> } | null = null
const aliasCache = new Map<string, { at: number; aliases: Map<string, Alias> }>()

export function clearPickerRuleCache(): void {
  cache = null
  aliasCache.clear()
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

function isFilter(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0
}

const empty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

async function build(): Promise<Map<string, Rule[]>> {
  const out = new Map<string, Rule[]>()
  // Where the switch is on: field options, then active grouped layouts. The
  // layout wins for option_filter too, the way the form reads it.
  const flagged = new Map<string, { options: Record<string, unknown>; layout: boolean }>()
  const key = (c: string, f: string) => `${c}\u0000${f}`
  const fieldRows = (await db('nivaro_fields')
    .whereRaw("options LIKE '%enforce_picker_rules%'")
    .select('collection', 'field', 'options')) as Array<{
    collection: string
    field: string
    options: string | null
  }>
  for (const r of fieldRows) {
    const o = parseJson<Record<string, unknown>>(r.options)
    if (o?.enforce_picker_rules === true)
      flagged.set(key(r.collection, r.field), { options: o, layout: false })
  }
  const layoutRows = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .where('l.is_active', true)
    .where('l.layout_type', 'grouped')
    .whereRaw("a.overrides LIKE '%enforce_picker_rules%'")
    .select('l.collection', 'a.field', 'a.overrides')) as Array<{
    collection: string
    field: string
    overrides: string | null
  }>
  for (const r of layoutRows) {
    const o = parseJson<{ options?: Record<string, unknown> }>(r.overrides)?.options
    if (o?.enforce_picker_rules === true)
      flagged.set(key(r.collection, r.field), { options: o, layout: true })
  }
  if (flagged.size === 0) return out

  for (const [k, hit] of flagged) {
    const [collection, field] = k.split('\u0000')
    if (!IDENT.test(collection) || !IDENT.test(field)) continue
    const rel = (await db('nivaro_relations')
      .where({ many_collection: collection, many_field: field })
      .whereNull('junction_field')
      .first('one_collection')) as { one_collection: string | null } | undefined
    const target = rel?.one_collection
    if (!target || !IDENT.test(target)) continue
    const fieldRow = (await db('nivaro_fields')
      .where({ collection, field })
      .first('label', 'options', 'dependency_config')) as
      | { label: string | null; options: string | null; dependency_config: string | null }
      | undefined
    const fieldOptions = parseJson<Record<string, unknown>>(fieldRow?.options) ?? {}
    // A layout switch reads the layout's own option_filter when it sets one,
    // else the field's; a field switch reads the field's only.
    const optionFilter = hit.layout
      ? (hit.options.option_filter ?? fieldOptions.option_filter)
      : fieldOptions.option_filter
    const dep = parseJson<{ cascade_filters?: CascadeRule[] }>(fieldRow?.dependency_config)
    const cascades = (dep?.cascade_filters ?? []).filter(
      (c) =>
        typeof c?.parent_field === 'string' &&
        typeof c?.filter_column === 'string' &&
        IDENT.test(c.parent_field) &&
        c.filter_column.split('.').every((s) => IDENT.test(s))
    )
    const targetRow = (await db('nivaro_collections')
      .where({ collection: target })
      .first('picker_filter')) as { picker_filter: string | null } | undefined
    const pickerFilter = parseJson<Record<string, unknown>>(targetRow?.picker_filter)
    const rule: Rule = {
      collection,
      field,
      label: fieldRow?.label || field,
      target,
      cascades,
      optionFilter: isFilter(optionFilter) ? optionFilter : null,
      pickerFilter: isFilter(pickerFilter) ? pickerFilter : null
    }
    out.set(collection, [...(out.get(collection) ?? []), rule])
  }
  return out
}

async function rulesFor(collection: string): Promise<Rule[]> {
  if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), byCollection: await build() }
  return cache.byCollection.get(collection) ?? []
}

async function aliasesOf(collection: string): Promise<Map<string, Alias>> {
  const hit = aliasCache.get(collection)
  if (hit && Date.now() - hit.at < TTL) return hit.aliases
  const aliases = new Map<string, Alias>()
  const rows = (await db('nivaro_relations')
    .where({ one_collection: collection })
    .whereNotNull('junction_field')
    .whereNotNull('one_field')
    .select('one_field', 'many_collection', 'many_field', 'junction_field')) as Array<{
    one_field: string
    many_collection: string
    many_field: string
    junction_field: string
  }>
  for (const r of rows) {
    if (
      ![r.one_field, r.many_collection, r.many_field, r.junction_field].every((v) => IDENT.test(v))
    )
      continue
    aliases.set(r.one_field, {
      junction: r.many_collection,
      parentFk: r.many_field,
      targetFk: r.junction_field
    })
  }
  aliasCache.set(collection, { at: Date.now(), aliases })
  return aliases
}

// ── The same compilers the form runs ─────────────────────────────────────────

/** `$parent.<field>` tokens read off the row; a node that cannot resolve makes
 *  its whole top-level `_and` entry drop, or the whole filter when there is
 *  no `_and` (the form's resolveOptionFilterTokens). */
function resolveTokens(
  node: unknown,
  row: Record<string, unknown>,
  id: unknown
): { v: unknown; ok: boolean } {
  if (typeof node === 'string' && node.startsWith('$parent.')) {
    const k = node.slice('$parent.'.length)
    const val = k === 'id' ? id : row[k]
    return { v: val, ok: !empty(val) }
  }
  if (Array.isArray(node)) {
    const out: unknown[] = []
    for (const item of node) {
      const r = resolveTokens(item, row, id)
      if (!r.ok) return { v: out, ok: false }
      out.push(r.v)
    }
    return { v: out, ok: true }
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = resolveTokens(v, row, id)
      if (!r.ok) return { v: out, ok: false }
      out[k] = r.v
    }
    return { v: out, ok: true }
  }
  return { v: node, ok: true }
}

function resolveOptionFilter(
  filter: Record<string, unknown>,
  row: Record<string, unknown>,
  id: unknown
): Record<string, unknown> | null {
  if (Array.isArray(filter._and)) {
    const kept: unknown[] = []
    for (const entry of filter._and) {
      const r = resolveTokens(entry, row, id)
      if (r.ok) kept.push(r.v)
    }
    return kept.length > 0 ? { _and: kept } : null
  }
  const r = resolveTokens(filter, row, id)
  return r.ok ? (r.v as Record<string, unknown>) : null
}

/** The cascade clauses for the parent values the row holds (the form's
 *  buildCascadeFilter without the inherited-parent-filter branch). A parent
 *  the picker requires (`show_all_if_no_parent: false`) that is empty is
 *  returned so the refusal can name it. */
function buildCascade(
  rules: CascadeRule[],
  parentValue: (f: string) => unknown
): { filter: Record<string, unknown> | null; missingRequired: string[] } {
  let filter: Record<string, unknown> | null = null
  const missingRequired: string[] = []
  for (const rule of rules) {
    const pv = parentValue(rule.parent_field)
    if (empty(pv)) {
      if (rule.show_all_if_no_parent === false) missingRequired.push(rule.parent_field)
      continue
    }
    let fv: unknown = pv
    if (rule.value_map && typeof rule.value_map === 'object') {
      const vm = rule.value_map
      const one = (v: unknown) => vm[String(v)] ?? rule.value_map_default ?? v
      fv = Array.isArray(pv)
        ? [
            ...new Set(
              (pv as unknown[]).flatMap((v) => (Array.isArray(one(v)) ? one(v) : [one(v)]))
            )
          ]
        : one(pv)
    }
    const clause = Array.isArray(fv) ? { _in: fv } : { _eq: fv }
    if (!filter) filter = {}
    if (rule.filter_is_m2m) {
      filter[rule.filter_column] = { _some: { id: clause } }
    } else if (rule.filter_column.includes('.')) {
      const segs = rule.filter_column.split('.')
      let nested: Record<string, unknown> = clause
      for (let i = segs.length - 1; i >= 1; i--) nested = { [segs[i]]: nested }
      filter[segs[0]] = rule.filter_via_many ? { _some: nested } : nested
    } else {
      filter[rule.filter_column] = clause
    }
  }
  return { filter, missingRequired }
}

function refuse(message: string, extra: Record<string, unknown>) {
  return Object.assign(new Error(message), {
    statusCode: 400,
    code: 'PICKER_RULE_VIOLATED',
    ...extra
  })
}

/** Does the target hold `value` inside `filter`? Compiled by the items
 *  service's own filter compiler, so a rule reads exactly as the picker's
 *  option query does. */
async function offered(target: string, value: unknown, filter: Record<string, unknown>) {
  const { applyFilterToQuery } = await import('./items.js')
  const q = db(target).where(`${target}.id`, value as string | number)
  await applyFilterToQuery(q, filter, target)
  const hit = await q.first(`${target}.id as id`)
  return !!hit
}

export interface PickerRulesInput {
  collection: string
  /** The row as it would be stored (previous values merged under the payload). */
  row: Record<string, unknown>
  /** The fields the caller named — only those are judged. */
  callerFields: Set<string>
  /** The record's id on update; parent fields the payload does not carry are
   *  read from its links. */
  id?: string | number | null
}

/**
 * Refuses a value the field's picker would not offer for this record. A
 * failure to READ the rules never stops a write; a value outside the rules
 * does.
 */
export async function enforcePickerRules(input: PickerRulesInput): Promise<void> {
  let rules: Rule[]
  try {
    rules = await rulesFor(input.collection)
  } catch {
    return
  }
  if (rules.length === 0) return
  const { row, id } = input
  let aliases: Map<string, Alias> | null = null
  const linkCache = new Map<string, unknown[]>()
  const parentValue = async (field: string): Promise<unknown> => {
    if (field in row) {
      const v = row[field]
      // A relation object the caller sent unreduced is not a value to judge.
      return v && typeof v === 'object' && !Array.isArray(v) ? undefined : v
    }
    if (id == null) return undefined
    aliases ??= await aliasesOf(input.collection)
    const a = aliases.get(field)
    if (!a) return undefined
    if (!linkCache.has(field)) {
      const links = (await db(a.junction)
        .where({ [a.parentFk]: id })
        .select(a.targetFk)) as Array<Record<string, unknown>>
      linkCache.set(
        field,
        links.map((l) => l[a.targetFk]).filter((v) => v !== null && v !== undefined)
      )
    }
    return linkCache.get(field)
  }

  for (const rule of rules) {
    if (!input.callerFields.has(rule.field)) continue
    const value = row[rule.field]
    if (empty(value) || typeof value === 'object') continue
    const where = (r: string) => ({
      field: rule.field,
      rule: r,
      value,
      target: rule.target
    })

    // Cascade: parents first, so a required parent that is empty is named.
    if (rule.cascades.length > 0) {
      const values = new Map<string, unknown>()
      for (const c of rule.cascades) {
        if (!values.has(c.parent_field))
          values.set(c.parent_field, await parentValue(c.parent_field))
      }
      const { filter, missingRequired } = buildCascade(rule.cascades, (f) => values.get(f))
      if (missingRequired.length > 0) {
        throw refuse(
          `"${rule.label}" needs ${missingRequired.join(' and ')} set first; the picker offers nothing without it`,
          { ...where('cascade'), parents: missingRequired }
        )
      }
      if (filter && !(await offered(rule.target, value, filter))) {
        const parents = rule.cascades
          .map((c) => c.parent_field)
          .filter((p, i, arr) => arr.indexOf(p) === i && !empty(values.get(p)))
        throw refuse(
          `"${rule.label}" cannot be ${String(value)}: it is not an option for this record's ${parents.join(', ')}`,
          { ...where('cascade'), parents }
        )
      }
    }

    if (rule.optionFilter) {
      const filter = resolveOptionFilter(rule.optionFilter, row, id ?? row.id)
      if (filter && !(await offered(rule.target, value, filter))) {
        throw refuse(
          `"${rule.label}" cannot be ${String(value)}: it is outside the options this field offers`,
          where('option_filter')
        )
      }
    }

    if (rule.pickerFilter && !(await offered(rule.target, value, rule.pickerFilter))) {
      throw refuse(
        `"${rule.label}" cannot be ${String(value)}: ${rule.target} keeps that record out of pickers`,
        where('picker_filter')
      )
    }

    const excluded = await db('nivaro_picker_exclusions')
      .where({ collection: rule.target, item_id: String(value) })
      .first('id')
    if (excluded) {
      throw refuse(
        `"${rule.label}" cannot be ${String(value)}: that record is excluded from pickers`,
        where('picker_exclusion')
      )
    }
  }
}
