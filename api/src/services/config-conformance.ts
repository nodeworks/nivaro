import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import { RowRuleLookupCache } from './field-rules.js'
import {
  type IntegrityCheck,
  integrityCheckCounts,
  integrityChecksFor
} from './integrity-checks.js'
import { getLabels } from './queues.js'
import {
  type GridRuleConfig,
  gridRuleConfigsFor,
  parentContextFrom,
  parentFieldsFor,
  planRowRuleChanges
} from './row-rules-apply.js'
import { applyValidationRule, type ValidationRule } from './validation-rules.js'

/**
 * Config conformance — which items would FAIL their own form if someone
 * opened them today.
 *
 * Field config accumulates (required flags, validation rules, cascade
 * filters) while the data underneath predates it, drifts through imports, or
 * loses eligibility when a parent link changes — the classic symptom being a
 * picker showing "this value is not an available option". This sweep
 * compiles the CURRENT field config into checks and evaluates real rows
 * against it, so admins see the whole backlog instead of discovering rows
 * one form-open at a time.
 *
 * Everything is batched per chunk: junction sets for M2M cascade parents are
 * one query per rule per chunk, availability is one query per rule per chunk
 * over the DISTINCT child values — never per row. Rules the sweep cannot
 * evaluate faithfully (dotted filter columns, $parent token filters) are
 * skipped rather than guessed: a false "broken" flag costs more trust than a
 * silent skip.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CHUNK = 500
const DEFAULT_ROW_CAP = 5000

export interface CascadeCheck {
  field: string
  fieldLabel: string
  parent_field: string
  parentLabel: string
  /** Parent is an M2M alias on the source collection (value = junction set). */
  parentIsM2M: boolean
  parentJunction?: { table: string; srcFk: string; tgtFk: string }
  /** The cascaded field itself is an M2M alias — its "value" is the set of
   *  linked ids, each of which must be available under the parent. */
  childIsM2M: boolean
  childJunction?: { table: string; srcFk: string; tgtFk: string }
  /** Target collection the child value(s) point at. */
  target: string
  filter_column: string
  /** Filter column is an M2M alias on the TARGET collection. */
  filterIsM2M: boolean
  filterJunction?: { table: string; srcFk: string; tgtFk: string }
}

interface RequiredCheck {
  field: string
  label: string
  kind: 'column' | 'm2m'
  junction?: { table: string; srcFk: string; tgtFk: string }
}

interface DisplayToken {
  raw: string
  /** Pre-resolved M2O hops for a dotted token; empty for a plain column. */
  hops: Array<{ fk: string; target: string }>
  /** The column read at the end of the hop chain (or directly on the row). */
  leaf: string
}

interface DateOffsetCheck {
  field: string
  label: string
  /** 'min' | 'max' days from the record's CREATION date — the historical
   *  reading of a from-today rule. */
  op: 'min' | 'max'
  days: number
  baseline: string
}

/** An M2O column whose picker is narrowed by the field's own `option_filter`
 *  (an active-only picker, a CIFA column that hides catalogue defaults): a
 *  stored value the picker would no longer offer. Only STATIC filters are
 *  swept — one with `$parent.<field>` tokens depends on the open record and
 *  is judged by the grid at render time instead. */
export interface OptionFilterCheck {
  field: string
  fieldLabel: string
  target: string
  filter: Record<string, unknown>
  /** The picker's pinned defaults (`pinned_options`): the row's PARENT
   *  record (reached through `childFk`) links a `parent_collection` record
   *  via `parent_field`, and that record's `source_field` is offered at the
   *  top of the picker outside the filter — so it is never stale for that
   *  row, exactly as the picker never flags it. */
  pinnedSources: Array<{
    childFk: string
    parentField: string
    parentCollection: string
    sourceField: string
  }>
}

interface CompiledChecks {
  collection: string
  requiredFields: RequiredCheck[]
  validation: Array<{ field: string; label: string; rules: ValidationRule[] }>
  dateOffsets: DateOffsetCheck[]
  cascades: CascadeCheck[]
  optionFilters: OptionFilterCheck[]
  /** Display-template parts — a record whose parts all resolve empty renders
   *  as its internal id everywhere labels are used. */
  displayTokens: DisplayToken[]
  /** Inline-grid row rules (task / labor price / line type autofill) judged
   *  against every SAVED child row of each record. */
  rowRules: RowRuleCheck[]
  /** Extension-registered checks (services/integrity-checks.ts) — judged over
   *  the batch's ids by the extension that owns the domain. */
  external: IntegrityCheck[]
  /** Rules present in config but not evaluable by this sweep. */
  skipped: string[]
}

export interface RowRuleCheck extends GridRuleConfig {
  /** Child column used to name a line in messages ("Line 3"), when present. */
  lineField: string | null
  /** Child field labels + display hints for the message. */
  childFields: Map<string, { label: string; currency: boolean; relatedCollection: string | null }>
}

function parseJson<T>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

const label = (field: string) =>
  field
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    // Title-casing a machine name turns "po_line_type" into "Po Line Type";
    // the acronyms people actually read stay upper-case.
    .replace(/\b(Po|Id|Sku|Cifa|Req|Mwf|Sla)\b/g, (m) => m.toUpperCase())

/** Calendar day (UTC ms at midnight) from a Date or date-ish string; bare
 *  yyyy-mm-dd parses without timezone shifting. */
function parseDay(v: unknown): number | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const t = Date.parse(String(v))
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

const physicalColsCache = new Map<string, Set<string>>()
async function hasPhysicalColumn(table: string, column: string): Promise<boolean> {
  let cols = physicalColsCache.get(table)
  if (!cols) {
    const rows = (await db.raw(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`,
      [table]
    )) as Array<{ COLUMN_NAME: string }>
    cols = new Set(rows.map((r) => r.COLUMN_NAME))
    physicalColsCache.set(table, cols)
  }
  return cols.has(column)
}

/** Resolve an M2M alias field to its junction wiring. The alias relation row
 *  carries junction_field as the pairing marker (many = junction table,
 *  many_field = fk to the alias's own collection, junction_field = fk to the
 *  target) — the same reading the auto-id and scope resolvers use. The
 *  companion leg (same junction, many_field = tgtFk) names the TARGET
 *  collection when it exists. */
async function resolveAlias(
  collection: string,
  alias: string
): Promise<{ table: string; srcFk: string; tgtFk: string; target: string | null } | null> {
  const rel = (await db('nivaro_relations')
    .where({ one_collection: collection, one_field: alias })
    .whereNotNull('junction_field')
    .first('many_collection', 'many_field', 'junction_field')) as
    | { many_collection: string; many_field: string; junction_field: string }
    | undefined
  if (!rel) return null
  if (![rel.many_collection, rel.many_field, rel.junction_field].every((v) => IDENT.test(v))) {
    return null
  }
  const companion = (await db('nivaro_relations')
    .where({ many_collection: rel.many_collection, many_field: rel.junction_field })
    .first('one_collection')) as { one_collection: string | null } | undefined
  const target =
    companion?.one_collection && IDENT.test(companion.one_collection)
      ? companion.one_collection
      : null
  return { table: rel.many_collection, srcFk: rel.many_field, tgtFk: rel.junction_field, target }
}

/** Which grouped layouts show each field. A field absent from SOME grouped
 *  layout is layout-dependent: records opened on that layout never see it,
 *  so a required/validation finding would be a false positive for them (the
 *  CAR/PUB workflows case — vendor is required on the default layout but the
 *  pub-request layout has no vendor at all). */
async function layoutPresence(
  collection: string
): Promise<{ layouts: Array<{ id: number; name: string }>; visibleOn: Map<string, Set<number>> }> {
  // Only layouts a record can actually OPEN as its form gate the checks:
  // the active layout, plus slugged variants (Unit/Non-Unit/Sparing orders).
  // Excluded: inactive slugless layouts (unreachable — nothing resolves
  // them) and create_hidden ones (special-purpose sub-forms like the
  // warehouse-submission line-entry layout) — counting those gated EVERY
  // required field out of collections that use per-record layout variants.
  const layouts = (
    (await db('nivaro_collection_layouts')
      .where({ collection, layout_type: 'grouped' })
      .select('id', 'name', 'is_active', 'slug', 'create_hidden')) as Array<{
      id: number
      name: string
      is_active: unknown
      slug: string | null
      create_hidden: unknown
    }>
  ).filter(
    (l) =>
      l.is_active === true ||
      l.is_active === 1 ||
      (l.slug && !(l.create_hidden === true || l.create_hidden === 1))
  )
  const visibleOn = new Map<string, Set<number>>()
  if (layouts.length === 0) return { layouts, visibleOn }
  const assignments = (await db('nivaro_layout_field_assignments')
    .whereIn(
      'layout_id',
      layouts.map((l) => l.id)
    )
    .where('is_visible', true)
    .select('layout_id', 'field')) as Array<{ layout_id: number; field: string }>
  for (const a of assignments) {
    if (!visibleOn.has(a.field)) visibleOn.set(a.field, new Set())
    visibleOn.get(a.field)?.add(a.layout_id)
  }
  return { layouts, visibleOn }
}

export async function compileChecks(collection: string): Promise<CompiledChecks> {
  const fields = (await db('nivaro_fields')
    .where({ collection })
    .select(
      'field',
      'label',
      'required',
      'validation_rules',
      'dependency_config',
      'options'
    )) as Array<{
    field: string
    label: string | null
    required: unknown
    validation_rules: unknown
    dependency_config: unknown
    options: unknown
  }>

  // Human labels, the way the FORM shows them: the active layout's
  // assignment label wins (that's where "Zone" and "Ship-To Contact" live),
  // then the field's own label, then a title-cased machine name.
  const labelMap = new Map<string, string>()
  for (const f of fields) {
    if (f.label) labelMap.set(f.field, f.label)
  }
  const activeLayout = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped', is_active: true })
    .first('id')) as { id: number } | undefined
  if (activeLayout) {
    const asg = (await db('nivaro_layout_field_assignments')
      .where('layout_id', activeLayout.id)
      .select('field', 'label_override', 'overrides')) as Array<{
      field: string
      label_override: string | null
      overrides: unknown
    }>
    for (const a of asg) {
      const o = parseJson<{ label?: string }>(a.overrides)
      const l = o?.label || a.label_override
      if (l) labelMap.set(a.field, l)
    }
  }
  const labelFor = (field: string): string => labelMap.get(field) ?? label(field)

  const out: CompiledChecks = {
    collection,
    requiredFields: [],
    validation: [],
    cascades: [],
    optionFilters: [],
    displayTokens: [],
    dateOffsets: [],
    rowRules: [],
    external: [],
    skipped: []
  }
  const { layouts, visibleOn } = await layoutPresence(collection)
  // Creation-timestamp column for the historical reading of date-offset
  // rules ("at least 7 days from today" AT ENTRY = delivery >= created + 7).
  const creationBaseline = (await hasPhysicalColumn(collection, 'date_created'))
    ? 'date_created'
    : (await hasPhysicalColumn(collection, 'created_at'))
      ? 'created_at'
      : null

  // Display template completeness — each {{token}} should resolve to a value,
  // or the record renders as its internal id in pickers, queues and labels.
  const meta = (await db('nivaro_collections').where({ collection }).first('display_template')) as
    | { display_template: string | null }
    | undefined
  for (const m of String(meta?.display_template ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const path = m[1].split('.')
    if (path.length > 3 || path.some((seg) => !IDENT.test(seg))) {
      out.skipped.push(`display template token {{${m[1]}}} not evaluable`)
      continue
    }
    const hops: Array<{ fk: string; target: string }> = []
    let cur = collection
    let ok = true
    for (let i = 0; i < path.length - 1; i++) {
      const rel = (await db('nivaro_relations')
        .where({ many_collection: cur, many_field: path[i] })
        .whereNull('junction_field')
        .first('one_collection')) as { one_collection: string | null } | undefined
      if (!rel?.one_collection || !IDENT.test(rel.one_collection)) {
        ok = false
        break
      }
      hops.push({ fk: path[i], target: rel.one_collection })
      cur = rel.one_collection
    }
    if (!ok) {
      out.skipped.push(`display template token {{${m[1]}}} not evaluable`)
      continue
    }
    out.displayTokens.push({ raw: m[1], hops, leaf: path[path.length - 1] })
  }

  // A form-entry rule (required/validation) only binds records whose layout
  // actually SHOWS the field. With multiple grouped layouts we cannot know
  // per record which one a host renders, so a field absent from any of them
  // is layout-dependent — skipped honestly rather than flagged wrongly.
  const onEveryLayout = (field: string): { ok: boolean; missing: string[] } => {
    if (layouts.length === 0) return { ok: true, missing: [] }
    const present = visibleOn.get(field) ?? new Set<number>()
    const missing = layouts.filter((l) => !present.has(l.id)).map((l) => l.name)
    return { ok: missing.length === 0, missing }
  }

  for (const f of fields) {
    if (!IDENT.test(f.field)) continue
    if (f.required === true || f.required === 1) {
      const presence = onEveryLayout(f.field)
      if (!presence.ok) {
        out.skipped.push(
          `${f.field}: required, but layout-dependent (not on ${presence.missing.join(', ')})`
        )
      } else {
        const alias = await resolveAlias(collection, f.field)
        out.requiredFields.push(
          alias
            ? { field: f.field, label: labelFor(f.field), kind: 'm2m', junction: alias }
            : { field: f.field, label: labelFor(f.field), kind: 'column' }
        )
      }
    }
    const rules = parseJson<ValidationRule[]>(f.validation_rules)
    if (Array.isArray(rules) && rules.length > 0) {
      // Date-offset rules ('at least N days from today') judge the moment of
      // ENTRY — every record naturally ages past them, so a naive history
      // sweep flags perfectly good records. The historically faithful form
      // compares against the record's CREATION date instead: a violation
      // means the rule was already broken when the value was set (imports,
      // API writes) — that we CAN check.
      const sweepable: ValidationRule[] = []
      for (const r of rules) {
        if (r.type === 'min_days_from_today' || r.type === 'max_days_from_today') {
          const days = Number(r.value)
          if (creationBaseline && Number.isFinite(days)) {
            out.dateOffsets.push({
              field: f.field,
              label: labelFor(f.field),
              op: r.type === 'min_days_from_today' ? 'min' : 'max',
              days,
              baseline: creationBaseline
            })
          } else {
            out.skipped.push(
              `${f.field}: date-offset rule needs a creation timestamp column to check historically`
            )
          }
        } else {
          sweepable.push(r)
        }
      }
      if (sweepable.length > 0) {
        const presence = onEveryLayout(f.field)
        if (!presence.ok) {
          out.skipped.push(
            `${f.field}: validation rules, but layout-dependent (not on ${presence.missing.join(', ')})`
          )
        } else {
          out.validation.push({ field: f.field, label: labelFor(f.field), rules: sweepable })
        }
      }
    }
    const dep = parseJson<{
      cascade_filters?: Array<{
        parent_field?: string
        filter_column?: string
        filter_is_m2m?: boolean
        filter_via_many?: boolean
      }>
    }>(f.dependency_config)
    for (const c of dep?.cascade_filters ?? []) {
      if (!c.parent_field || !c.filter_column) continue
      if (c.filter_column.includes('.') || c.filter_via_many) {
        out.skipped.push(`${f.field}: cascade via ${c.filter_column} (dotted/via-many path)`)
        continue
      }
      if (!IDENT.test(c.parent_field) || !IDENT.test(c.filter_column)) continue
      // The cascaded field is either a plain M2O column or an M2M alias —
      // an alias's "value" is its junction set, each link checked.
      let target: string | null = null
      let childIsM2M = false
      let childJunction: { table: string; srcFk: string; tgtFk: string } | undefined
      const m2o = (await db('nivaro_relations')
        .where({ many_collection: collection, many_field: f.field })
        .whereNull('junction_field')
        .first('one_collection')) as { one_collection: string | null } | undefined
      if (m2o?.one_collection && IDENT.test(m2o.one_collection)) {
        target = m2o.one_collection
      } else {
        const childAlias = await resolveAlias(collection, f.field)
        if (childAlias?.target) {
          childIsM2M = true
          childJunction = childAlias
          target = childAlias.target
        }
      }
      if (!target) {
        out.skipped.push(`${f.field}: cascade target unresolvable`)
        continue
      }
      const check: CascadeCheck = {
        field: f.field,
        fieldLabel: labelFor(f.field),
        parent_field: c.parent_field,
        parentLabel: labelFor(c.parent_field),
        parentIsM2M: false,
        childIsM2M,
        childJunction,
        target,
        filter_column: c.filter_column,
        filterIsM2M: false
      }
      // Parent may be an M2M alias on the source collection.
      const parentAlias = await resolveAlias(collection, c.parent_field)
      if (parentAlias) {
        check.parentIsM2M = true
        check.parentJunction = parentAlias
      }
      // The filter column's mode comes from the TARGET's schema, never from
      // the config flag — the client's filter compiler resolves alias columns
      // transparently, so real configs routinely omit filter_is_m2m on
      // columns that are aliases (a category filtered by the parent's
      // regions M2M was the live example).
      const filterAlias = await resolveAlias(check.target, c.filter_column)
      if (filterAlias) {
        check.filterIsM2M = true
        check.filterJunction = filterAlias
      } else if (!(await hasPhysicalColumn(check.target, c.filter_column))) {
        out.skipped.push(
          `${f.field}: cascade filter ${check.target}.${c.filter_column} is neither a column nor an alias`
        )
        continue
      }
      out.cascades.push(check)
    }
  }

  // ── option_filter availability ───────────────────────────────────────────
  for (const f of fields) {
    if (!IDENT.test(f.field)) continue
    const opts = parseJson<{
      option_filter?: unknown
      pinned_options?: Array<{
        parent_collection?: string
        source_field?: string
        parent_field?: string
      }>
    }>(f.options)
    const filter = opts?.option_filter
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) continue
    if (JSON.stringify(filter).includes('$parent.')) {
      out.skipped.push(`${f.field}: option_filter reads the parent record ($parent tokens)`)
      continue
    }
    const m2o = (await db('nivaro_relations')
      .where({ many_collection: collection, many_field: f.field })
      .whereNull('junction_field')
      .first('one_collection')) as { one_collection: string | null } | undefined
    if (!m2o?.one_collection || !IDENT.test(m2o.one_collection)) continue
    const pinnedSources: OptionFilterCheck['pinnedSources'] = []
    for (const p of opts?.pinned_options ?? []) {
      if (
        typeof p?.parent_collection !== 'string' ||
        typeof p?.source_field !== 'string' ||
        typeof p?.parent_field !== 'string' ||
        !IDENT.test(p.parent_collection) ||
        !IDENT.test(p.source_field) ||
        !IDENT.test(p.parent_field)
      )
        continue
      // The row's FK to its parent: an M2O on this collection whose target
      // carries `parent_field` pointing at `parent_collection`.
      const fks = (await db('nivaro_relations')
        .where({ many_collection: collection })
        .whereNull('junction_field')
        .select('many_field', 'one_collection')) as Array<{
        many_field: string
        one_collection: string | null
      }>
      let childFk: string | null = null
      for (const r of fks) {
        if (!r.one_collection || !IDENT.test(r.many_field)) continue
        const hop = await db('nivaro_relations')
          .where({
            many_collection: r.one_collection,
            many_field: p.parent_field,
            one_collection: p.parent_collection
          })
          .whereNull('junction_field')
          .first('id')
        if (hop) {
          childFk = r.many_field
          break
        }
      }
      if (!childFk) continue
      if (
        !pinnedSources.some(
          (x) =>
            x.childFk === childFk &&
            x.parentField === p.parent_field &&
            x.parentCollection === p.parent_collection &&
            x.sourceField === p.source_field
        )
      ) {
        pinnedSources.push({
          childFk,
          parentField: p.parent_field,
          parentCollection: p.parent_collection,
          sourceField: p.source_field
        })
      }
    }
    out.optionFilters.push({
      field: f.field,
      fieldLabel: labelFor(f.field),
      target: m2o.one_collection,
      filter: filter as Record<string, unknown>,
      pinnedSources
    })
  }

  // ── inline-grid row rules ────────────────────────────────────────────────
  // The same rules the grid runs as a line is typed and the API runs on a
  // line create: a saved line whose stored target differs from what the
  // rules derive TODAY is the "labor line priced at $40" class of drift.
  for (const cfg of await gridRuleConfigsFor(collection).catch(() => [] as GridRuleConfig[])) {
    const childFieldRows = (await db('nivaro_fields')
      .where({ collection: cfg.childCollection })
      .select('field', 'label', 'options')) as Array<{
      field: string
      label: string | null
      options: unknown
    }>
    const childRels = (await db('nivaro_relations')
      .where({ many_collection: cfg.childCollection })
      .whereNotNull('one_collection')
      .select('many_field', 'one_collection')) as Array<{
      many_field: string
      one_collection: string
    }>
    const childFields = new Map<
      string,
      { label: string; currency: boolean; relatedCollection: string | null }
    >()
    for (const f of childFieldRows) {
      const o = parseJson<{ format?: string }>(f.options)
      childFields.set(f.field, {
        label: f.label || label(f.field),
        currency: o?.format === 'currency' || /price|amount|cost|total/i.test(f.field),
        relatedCollection: childRels.find((r) => r.many_field === f.field)?.one_collection ?? null
      })
    }
    const lineField = (await hasPhysicalColumn(cfg.childCollection, 'line_number'))
      ? 'line_number'
      : null
    out.rowRules.push({ ...cfg, lineField, childFields })
  }
  out.external = integrityChecksFor(collection)
  return out
}

export interface CollectionCheckSummary {
  collection: string
  required: number
  validation: number
  cascade: number
  /** Inline grids on the active layout carrying row rules. */
  row_rules: number
  /** Extension-registered checks. */
  external: number
  skipped: number
}

/**
 * Per-collection check counts for the picker, computed from THREE bulk
 * queries instead of compiling every collection serially (230 collections x
 * several ~37ms round trips each made the dropdown take seconds). Counts are
 * a preview — exact compilation (alias resolution etc.) happens at run time.
 */
export async function summarizeAllCollections(): Promise<Map<string, CollectionCheckSummary>> {
  const [fields, layouts, assignments] = await Promise.all([
    db('nivaro_fields')
      .where((qb) =>
        qb
          .where('required', true)
          .orWhereNotNull('validation_rules')
          .orWhereNotNull('dependency_config')
          .orWhere('options', 'like', '%option_filter%')
      )
      .select(
        'collection',
        'field',
        'required',
        'validation_rules',
        'dependency_config',
        'options'
      ) as Promise<
      Array<{
        collection: string
        field: string
        options: unknown
        required: unknown
        validation_rules: unknown
        dependency_config: unknown
      }>
    >,
    db('nivaro_collection_layouts')
      .where('layout_type', 'grouped')
      // Same reachability rule as layoutPresence — the two must not drift.
      .where((qb) =>
        qb
          .where('is_active', true)
          .orWhere((q2) => q2.whereNotNull('slug').where('create_hidden', false))
      )
      .select('id', 'collection') as Promise<Array<{ id: number; collection: string }>>,
    db('nivaro_layout_field_assignments')
      .where('is_visible', true)
      .select('layout_id', 'field') as Promise<Array<{ layout_id: number; field: string }>>
  ])

  const layoutsByCollection = new Map<string, number[]>()
  for (const l of layouts) {
    if (!layoutsByCollection.has(l.collection)) layoutsByCollection.set(l.collection, [])
    layoutsByCollection.get(l.collection)?.push(l.id)
  }
  const visibleByLayout = new Map<number, Set<string>>()
  for (const a of assignments) {
    if (!visibleByLayout.has(a.layout_id)) visibleByLayout.set(a.layout_id, new Set())
    visibleByLayout.get(a.layout_id)?.add(a.field)
  }
  const onEvery = (collection: string, field: string): boolean => {
    const ids = layoutsByCollection.get(collection)
    if (!ids || ids.length === 0) return true
    return ids.every((id) => visibleByLayout.get(id)?.has(field))
  }

  const out = new Map<string, CollectionCheckSummary>()
  const entry = (collection: string): CollectionCheckSummary => {
    let e = out.get(collection)
    if (!e) {
      e = {
        collection,
        required: 0,
        validation: 0,
        cascade: 0,
        row_rules: 0,
        external: 0,
        skipped: 0
      }
      out.set(collection, e)
    }
    return e
  }
  for (const f of fields) {
    if (!IDENT.test(f.collection) || /^nivaro_|^directus_/i.test(f.collection)) continue
    if (!IDENT.test(f.field)) continue
    const e = entry(f.collection)
    const bound = onEvery(f.collection, f.field)
    if (f.required === true || f.required === 1) {
      if (bound) e.required++
      else e.skipped++
    }
    const rules = parseJson<ValidationRule[]>(f.validation_rules)
    if (Array.isArray(rules) && rules.length > 0) {
      if (bound) e.validation++
      else e.skipped++
    }
    const dep = parseJson<{
      cascade_filters?: Array<{
        parent_field?: string
        filter_column?: string
        filter_via_many?: boolean
      }>
    }>(f.dependency_config)
    for (const c of dep?.cascade_filters ?? []) {
      if (!c.parent_field || !c.filter_column) continue
      if (c.filter_column.includes('.') || c.filter_via_many) e.skipped++
      else e.cascade++
    }
    const optFilter = parseJson<{ option_filter?: unknown }>(f.options)?.option_filter
    if (optFilter && typeof optFilter === 'object') {
      if (JSON.stringify(optFilter).includes('$parent.')) e.skipped++
      else e.cascade++
    }
  }
  // Grids with row rules on ACTIVE grouped layouts — one query, LIKE-narrowed
  // to the handful of assignment rows that carry them.
  const gridRows = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .where('l.is_active', true)
    .where('l.layout_type', 'grouped')
    .whereRaw("a.overrides LIKE '%row_rules%'")
    .select('l.collection')
    .catch(() => [])) as Array<{ collection: string }>
  for (const g of gridRows) {
    if (!IDENT.test(g.collection) || /^nivaro_|^directus_/i.test(g.collection)) continue
    entry(g.collection).row_rules++
  }
  for (const [collection, n] of integrityCheckCounts()) {
    if (!IDENT.test(collection) || /^nivaro_|^directus_/i.test(collection)) continue
    entry(collection).external += n
  }
  return out
}

export interface ConformanceSummary {
  checked: number
  violations: number
  truncated: boolean
  ruleCounts: Record<string, number>
  fieldCounts: Record<string, number>
}

export async function runConformance(
  runId: number,
  collection: string,
  rowCap = DEFAULT_ROW_CAP
): Promise<void> {
  try {
    const checks = await compileChecks(collection)
    const summary = await evaluate(runId, checks, rowCap)
    await db('nivaro_conformance_runs')
      .where('id', runId)
      .update({
        status: 'completed',
        checked_records: summary.checked,
        violation_count: summary.violations,
        truncated: summary.truncated,
        rule_counts: JSON.stringify(summary.ruleCounts),
        field_counts: JSON.stringify(summary.fieldCounts),
        finished_at: new Date()
      })
  } catch (err) {
    await db('nivaro_conformance_runs')
      .where('id', runId)
      .update({
        status: 'error',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
        finished_at: new Date()
      })
      .catch(() => {})
  }
}

/** The physical columns a check set needs from the parent row — required
 *  flags on alias fields (M2M pickers) have no scalar column to test here. */
async function columnsFor(
  checks: CompiledChecks
): Promise<{ physical: Set<string>; selectable: string[] }> {
  const { collection } = checks
  const columns = new Set<string>(['id'])
  for (const r of checks.requiredFields) {
    if (r.kind === 'column') columns.add(r.field)
  }
  for (const v of checks.validation) columns.add(v.field)
  for (const c of checks.cascades) {
    if (!c.childIsM2M) columns.add(c.field)
    if (!c.parentIsM2M) columns.add(c.parent_field)
  }
  for (const o of checks.optionFilters) {
    columns.add(o.field)
    for (const p of o.pinnedSources) columns.add(p.childFk)
  }
  for (const t of checks.displayTokens) {
    columns.add(t.hops.length > 0 ? t.hops[0].fk : t.leaf)
  }
  for (const d of checks.dateOffsets) {
    columns.add(d.field)
    columns.add(d.baseline)
  }
  for (const rc of checks.rowRules) {
    for (const f of parentFieldsFor(rc)) columns.add(f)
  }
  const physical = new Set(
    (
      (await db.raw(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`, [
        collection
      ])) as Array<{ COLUMN_NAME: string }>
    ).map((c) => c.COLUMN_NAME)
  )
  const selectable = [...columns].filter((c) => physical.has(c))
  return { physical, selectable }
}

export interface RecordFinding {
  item_id: string
  field: string
  rule: string
  message: string
}

/**
 * Evaluate every compiled check over one batch of parent rows. Shared by the
 * collection sweep (chunk by chunk) and the per-record live check the form
 * banner fires on load — one evaluator, so the two can never disagree.
 *
 * PARALLEL by section: the cascade rules, the required-M2M probes, the
 * display tokens and the row-rule grids are independent reads, and at this
 * server's ~40ms round trip a single record's ~50 serial queries cost 2.4s
 * while the same work in parallel is a handful of round trips deep. Junction
 * reads are memoized per call — the 19 workflows cascades re-read
 * workflows_regions five times otherwise. Findings are assembled in a fixed
 * section order so the output is stable regardless of which read lands first.
 */
async function evaluateRows(
  checks: CompiledChecks,
  rows: Array<Record<string, unknown>>,
  physical: Set<string>,
  rowRuleCache?: RowRuleLookupCache
): Promise<RecordFinding[]> {
  const { collection } = checks
  if (rows.length === 0) return []
  const rowIds = rows.map((r) => r.id)

  // Memoized junction fetch: (table, srcFk, tgtFk) over THIS batch's ids.
  const linkMemo = new Map<string, Promise<Array<Record<string, unknown>>>>()
  const links = (table: string, srcFk: string, tgtFk: string) => {
    const key = `${table}|${srcFk}|${tgtFk}`
    let hit = linkMemo.get(key)
    if (!hit) {
      hit = db(table)
        .whereIn(srcFk, rowIds as never[])
        .select(srcFk, tgtFk) as Promise<Array<Record<string, unknown>>>
      linkMemo.set(key, hit)
    }
    return hit
  }
  const setsFromLinks = (
    rowsIn: Array<Record<string, unknown>>,
    srcFk: string,
    tgtFk: string
  ): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>()
    for (const l of rowsIn) {
      const key = String(l[srcFk])
      if (!out.has(key)) out.set(key, new Set())
      out.get(key)?.add(String(l[tgtFk]))
    }
    return out
  }

  // ── required + validation, plain JS per row ──────────────────────────
  const scalar: RecordFinding[] = []
  for (const row of rows) {
    for (const r of checks.requiredFields) {
      if (r.kind !== 'column' || !physical.has(r.field)) continue
      const msg = applyValidationRule({ type: 'required' }, row[r.field], r.label)
      if (msg)
        scalar.push({ item_id: String(row.id), field: r.field, rule: 'required', message: msg })
    }
    for (const v of checks.validation) {
      if (!physical.has(v.field)) continue
      for (const rule of v.rules) {
        const msg = applyValidationRule(rule, row[v.field], v.label, row)
        if (msg) {
          scalar.push({ item_id: String(row.id), field: v.field, rule: 'validation', message: msg })
          break
        }
      }
    }
    for (const d of checks.dateOffsets) {
      if (!physical.has(d.field) || !physical.has(d.baseline)) continue
      const value = parseDay(row[d.field])
      const created = parseDay(row[d.baseline])
      if (value == null || created == null) continue
      const diff = Math.round((value - created) / 86_400_000)
      const bad = d.op === 'min' ? diff < d.days : diff > d.days
      if (bad) {
        scalar.push({
          item_id: String(row.id),
          field: d.field,
          rule: 'validation',
          message: `${d.label} was ${diff} day(s) from creation — the rule required at ${d.op === 'min' ? 'least' : 'most'} ${d.days}`
        })
      }
    }
  }

  // ── required M2M aliases: zero junction rows = empty ─────────────────
  const m2mRequired = async (): Promise<RecordFinding[]> => {
    const out: RecordFinding[] = []
    const probes = checks.requiredFields.filter((r) => r.kind === 'm2m' && r.junction)
    const linkedSets = await Promise.all(
      probes.map(async (r) => {
        const j = r.junction as NonNullable<typeof r.junction>
        // NOTE: .distinct(col).select(col) doubles the column on mssql and the
        // value comes back as a nested array (the chat-DM .pluck trap) — plain
        // .distinct(col) alone selects it correctly.
        const linked = (await db(j.table)
          .whereIn(j.srcFk, rowIds as never[])
          .distinct(j.srcFk)) as Array<Record<string, unknown>>
        return new Set(linked.map((l) => String(l[j.srcFk])))
      })
    )
    probes.forEach((r, idx) => {
      const linked = linkedSets[idx]
      for (const row of rows) {
        if (!linked.has(String(row.id))) {
          out.push({
            item_id: String(row.id),
            field: r.field,
            rule: 'required',
            message: `${r.label} has no linked records`
          })
        }
      }
    })
    return out
  }

  // ── cascade availability, batched per rule ───────────────────────────
  // A field with several cascade rules (unit: by project type, unit type
  // AND install location) reports ONE finding per record listing every
  // failing parent, not one row per rule.
  type CascadeHit = { rowId: string; c: CompiledChecks['cascades'][number]; bad: number }
  const cascadeOne = async (c: CompiledChecks['cascades'][number]): Promise<CascadeHit[]> => {
    if (!c.childIsM2M && !physical.has(c.field)) return []
    // Child value(s) per row: a plain M2O reads the column; an M2M alias
    // reads its junction set (each linked id must be available).
    const childSets = new Map<string, Set<string>>()
    if (c.childIsM2M && c.childJunction) {
      const j = c.childJunction
      for (const [k, v] of setsFromLinks(await links(j.table, j.srcFk, j.tgtFk), j.srcFk, j.tgtFk))
        childSets.set(k, v)
    } else {
      for (const row of rows) {
        const v = row[c.field]
        if (v != null && v !== '') childSets.set(String(row.id), new Set([String(v)]))
      }
    }
    // Parent value set per row.
    const parentSets = new Map<string, Set<string>>()
    if (c.parentIsM2M && c.parentJunction) {
      const j = c.parentJunction
      for (const [k, v] of setsFromLinks(await links(j.table, j.srcFk, j.tgtFk), j.srcFk, j.tgtFk))
        parentSets.set(k, v)
    } else if (physical.has(c.parent_field)) {
      for (const row of rows) {
        const pv = row[c.parent_field]
        if (pv != null && pv !== '') parentSets.set(String(row.id), new Set([String(pv)]))
      }
    }
    // Availability of the DISTINCT child values under each parent.
    const childVals = [...new Set([...childSets.values()].flatMap((set) => [...set]))]
    if (childVals.length === 0) return []
    // childValue → the set of parent values it is available under
    const availability = new Map<string, Set<string>>()
    if (c.filterIsM2M && c.filterJunction) {
      const j = c.filterJunction
      const rowsIn = (await db(j.table)
        .whereIn(j.srcFk, childVals as never[])
        .select(j.srcFk, j.tgtFk)) as Array<Record<string, unknown>>
      for (const [k, v] of setsFromLinks(rowsIn, j.srcFk, j.tgtFk)) availability.set(k, v)
    } else {
      const targets = (await db(c.target)
        .whereIn('id', childVals as never[])
        .select('id', c.filter_column)) as Array<Record<string, unknown>>
      for (const t of targets) {
        const fv = t[c.filter_column]
        availability.set(String(t.id), fv == null ? new Set() : new Set([String(fv)]))
      }
    }
    const hits: CascadeHit[] = []
    for (const row of rows) {
      const children = childSets.get(String(row.id))
      if (!children || children.size === 0) continue
      const parents = parentSets.get(String(row.id))
      // No parent value on the row: the picker would show all (or prune the
      // clause) — not a conformance failure.
      if (!parents || parents.size === 0) continue
      const bad = [...children].filter((child) => {
        const avail = availability.get(child)
        return !(avail && [...avail].some((a) => parents.has(a)))
      }).length
      if (bad > 0) hits.push({ rowId: String(row.id), c, bad })
    }
    return hits
  }
  const cascades = async (): Promise<RecordFinding[]> => {
    const hits = (await Promise.all(checks.cascades.map(cascadeOne))).flat()
    const agg = new Map<
      string,
      { field: string; fieldLabel: string; isM2M: boolean; badCount: number; parents: string[] }
    >()
    for (const h of hits) {
      const key = `${h.rowId}|${h.c.field}`
      let a = agg.get(key)
      if (!a) {
        a = {
          field: h.c.field,
          fieldLabel: h.c.fieldLabel,
          isM2M: h.c.childIsM2M,
          badCount: 0,
          parents: []
        }
        agg.set(key, a)
      }
      a.badCount = Math.max(a.badCount, h.bad)
      a.parents.push(h.c.parentLabel)
    }
    const out: RecordFinding[] = []
    for (const [key, a] of agg) {
      const rowId = key.slice(0, key.length - a.field.length - 1)
      const parents =
        a.parents.length > 1
          ? `${a.parents.slice(0, -1).join(', ')} or ${a.parents[a.parents.length - 1]}`
          : a.parents[0]
      out.push({
        item_id: rowId,
        field: a.field,
        rule: 'cascade',
        message: a.isM2M
          ? `${a.badCount} linked ${a.fieldLabel} value(s) are not available options for the current ${parents}`
          : `${a.fieldLabel} value is not an available option for the current ${parents}`
      })
    }
    return out
  }

  // ── display template completeness, hops batch-resolved per level ─────
  const display = async (): Promise<RecordFinding[]> => {
    if (checks.displayTokens.length === 0) return []
    const emptyParts = new Map<string, string[]>()
    const perToken = await Promise.all(
      checks.displayTokens.map(async (t) => {
        // rowId → current value along the hop chain
        let values = new Map<string, unknown>(
          rows.map((r) => [String(r.id), r[t.hops.length > 0 ? t.hops[0].fk : t.leaf]])
        )
        for (let i = 0; i < t.hops.length; i++) {
          const nextCol = i + 1 < t.hops.length ? t.hops[i + 1].fk : t.leaf
          const ids = [...new Set([...values.values()].filter((v) => v != null && v !== ''))]
          const fetched =
            ids.length === 0
              ? []
              : ((await db(t.hops[i].target)
                  .whereIn('id', ids as never[])
                  .select('id', nextCol)) as Array<Record<string, unknown>>)
          const byId = new Map(fetched.map((f) => [String(f.id), f[nextCol]]))
          values = new Map(
            [...values.entries()].map(([rowId, v]) => [
              rowId,
              v == null || v === '' ? null : (byId.get(String(v)) ?? null)
            ])
          )
        }
        return { raw: t.raw, values }
      })
    )
    for (const { raw, values } of perToken) {
      for (const [rowId, v] of values) {
        if (v == null || String(v).trim() === '') {
          if (!emptyParts.has(rowId)) emptyParts.set(rowId, [])
          emptyParts.get(rowId)?.push(raw)
        }
      }
    }
    const out: RecordFinding[] = []
    for (const [rowId, parts] of emptyParts) {
      out.push({
        item_id: rowId,
        field: parts[0].split('.')[0],
        rule: 'display',
        message: `Display template part(s) empty: ${parts.map((p) => `{{${p}}}`).join(', ')} — the record shows as its internal id`
      })
    }
    return out
  }

  // ── inline-grid row rules: stored child values vs what the rules derive ─
  const rowRules = async (): Promise<RecordFinding[]> =>
    (
      await Promise.all(
        checks.rowRules.map(async (rc) => {
          try {
            return await evaluateRowRuleCheck(rc, rows, rowRuleCache)
          } catch (err) {
            console.warn(
              `conformance row-rule check skipped for ${collection}.${rc.aliasField}:`,
              err
            )
            return []
          }
        })
      )
    ).flat()

  // ── extension checks: one batched call per check, findings anchored to
  // the check's own field + rule id ─────────────────────────────────────
  const external = async (): Promise<RecordFinding[]> =>
    (
      await Promise.all(
        checks.external.map(async (chk) => {
          try {
            const found = await chk.run(rowIds.map((id) => String(id)))
            return found.map((f) => ({
              item_id: String(f.item_id),
              field: chk.field,
              rule: chk.id,
              message: f.message
            }))
          } catch (err) {
            console.warn(`conformance check ${chk.id} skipped for ${collection}:`, err)
            return []
          }
        })
      )
    ).flat()

  // ── option_filter availability: the picker's own narrowing ──────────────
  const optionFilters = async (): Promise<RecordFinding[]> => {
    const out: RecordFinding[] = []
    if (checks.optionFilters.length === 0) return out
    const { applyFilterToQuery } = await import('./items.js')
    for (const c of checks.optionFilters) {
      if (!physical.has(c.field)) continue
      const vals = [
        ...new Set(
          rows
            .map((r) => r[c.field])
            .filter((v) => v != null && v !== '')
            .map(String)
        )
      ]
      if (vals.length === 0) continue
      let available: Set<string>
      try {
        const q = db(c.target)
          .whereIn('id', vals as never[])
          .select('id')
        await applyFilterToQuery(q, c.filter, c.target)
        available = new Set(((await q) as Array<{ id: unknown }>).map((x) => String(x.id)))
      } catch {
        continue // a filter the compiler cannot express is not a data fault
      }
      // Per-row pinned defaults: row → parent (childFk) → parent_field →
      // the parent_collection record's source_field.
      const pinnedByRow = new Map<string, Set<string>>()
      for (const src of c.pinnedSources) {
        if (!physical.has(src.childFk)) continue
        const parentIds = [
          ...new Set(
            rows
              .map((r) => r[src.childFk])
              .filter((v) => v != null && v !== '')
              .map(String)
          )
        ]
        if (parentIds.length === 0) continue
        // Which collection holds the parent rows? The child's FK target.
        const childRel = (await db('nivaro_relations')
          .where({ many_collection: collection, many_field: src.childFk })
          .whereNull('junction_field')
          .first('one_collection')
          .catch(() => null)) as { one_collection: string | null } | null
        if (!childRel?.one_collection || !IDENT.test(childRel.one_collection)) continue
        const parents = (await selectInChunks(parentIds, 1500, (chunk) =>
          db(childRel.one_collection as string)
            .whereIn('id', chunk as never[])
            .select('id', src.parentField)
        ).catch(() => [])) as Array<Record<string, unknown>>
        const linkIds = [
          ...new Set(
            parents
              .map((p) => p[src.parentField])
              .filter((v) => v != null)
              .map(String)
          )
        ]
        if (linkIds.length === 0) continue
        const linked = (await selectInChunks(linkIds, 1500, (chunk) =>
          db(src.parentCollection)
            .whereIn('id', chunk as never[])
            .select('id', src.sourceField)
        ).catch(() => [])) as Array<Record<string, unknown>>
        const defaultOf = new Map(linked.map((l) => [String(l.id), l[src.sourceField]]))
        const parentLink = new Map(parents.map((p) => [String(p.id), p[src.parentField]]))
        for (const row of rows) {
          const pid = row[src.childFk]
          if (pid == null) continue
          const link = parentLink.get(String(pid))
          const def = link == null ? null : defaultOf.get(String(link))
          if (def == null || def === '') continue
          const key = String(row.id)
          if (!pinnedByRow.has(key)) pinnedByRow.set(key, new Set())
          pinnedByRow.get(key)?.add(String(def))
        }
      }
      for (const row of rows) {
        const v = row[c.field]
        if (v == null || v === '') continue
        const sv = String(v)
        if (available.has(sv) || pinnedByRow.get(String(row.id))?.has(sv)) continue
        out.push({
          item_id: String(row.id),
          field: c.field,
          rule: 'option-filter',
          message: `${c.fieldLabel} holds a value the picker no longer offers`
        })
      }
    }
    return out
  }

  const [m2m, cas, opt, disp, rr, ext] = await Promise.all([
    m2mRequired(),
    cascades(),
    optionFilters(),
    display(),
    rowRules(),
    external()
  ])
  return [...scalar, ...m2m, ...cas, ...opt, ...disp, ...rr, ...ext]
}

// compileChecks walks field config + layouts + relations (~120 reads, 6s
// cold at this RTT); a form load must never pay that. One compiled set per
// collection, served STALE-WHILE-REVALIDATE: fresh for 5 minutes, and past
// that the stale set answers while a refresh runs behind it. Busted by the
// central metadata hook alongside every other per-collection cache.
interface Compiled {
  checks: CompiledChecks
  physical: Set<string>
  selectable: string[]
}
const compiledCache = new Map<string, { at: number; value: Promise<Compiled> }>()
const COMPILED_FRESH_MS = 5 * 60_000
export function bustCompiledChecks(collection?: string): void {
  if (collection) compiledCache.delete(collection)
  else compiledCache.clear()
}
async function buildCompiled(collection: string): Promise<Compiled> {
  const checks = await compileChecks(collection)
  const { physical, selectable } = await columnsFor(checks)
  return { checks, physical, selectable }
}
function compileChecksCached(collection: string): Promise<Compiled> {
  const hit = compiledCache.get(collection)
  if (hit) {
    if (Date.now() - hit.at >= COMPILED_FRESH_MS) {
      // Stale: refresh in the background, answer with what we have.
      const next = buildCompiled(collection)
      compiledCache.set(collection, { at: Date.now(), value: next })
      next.catch(() => compiledCache.set(collection, hit))
      return hit.value
    }
    return hit.value
  }
  const value = buildCompiled(collection)
  compiledCache.set(collection, { at: Date.now(), value })
  value.catch(() => compiledCache.delete(collection))
  return value
}
/**
 * Boot warm-up: compile the checks of every collection that carries a
 * layout (the ones a form can open) so the first record after a deploy gets
 * a warm live check instead of paying the ~6s compile. Sequential and
 * best-effort — a slow collection never blocks readiness.
 */
export async function warmCompiledChecks(): Promise<number> {
  const rows = (await db('nivaro_collection_layouts')
    .distinct('collection')
    .catch(() => [])) as Array<{ collection: string }>
  let n = 0
  for (const r of rows) {
    const c = String(r.collection)
    if (/^nivaro_|^directus_/i.test(c)) continue
    try {
      await compileChecksCached(c)
      n += 1
    } catch {
      /* best effort */
    }
  }
  return n
}

/** Does this collection have anything to check? Cheap once compiled. */
export async function hasChecks(collection: string): Promise<boolean> {
  const { checks } = await compileChecksCached(collection)
  return (
    checks.requiredFields.length +
      checks.validation.length +
      checks.cascades.length +
      checks.optionFilters.length +
      checks.displayTokens.length +
      checks.dateOffsets.length +
      checks.rowRules.length +
      checks.external.length >
    0
  )
}

// Row-rule lookups (relation rows + reference records the rules read) are
// shared across live checks for a short window — the cost of a cold check is
// almost entirely these reads. 20s is well inside what an integrity banner
// can be "wrong" by, and the sweep keeps its own per-chunk cache.
// (60s: reference rows the rules read — categories, catalog items, parent
// defaults — change on a human timescale.)
let liveRowRuleCache: { at: number; cache: RowRuleLookupCache } | null = null
const LIVE_CACHE_MS = 60_000
function liveCache(): RowRuleLookupCache {
  if (!liveRowRuleCache || Date.now() - liveRowRuleCache.at > LIVE_CACHE_MS) {
    liveRowRuleCache = { at: Date.now(), cache: new RowRuleLookupCache(db) }
  }
  return liveRowRuleCache.cache
}

/**
 * Live integrity check for ONE record — what the collection sweep would say
 * about it right now, from the same evaluator over a single row.
 * Returns null when the record does not exist.
 */
export async function checkRecord(
  collection: string,
  id: string
): Promise<{ findings: RecordFinding[]; ms: number } | null> {
  const t0 = Date.now()
  const { checks, physical, selectable } = await compileChecksCached(collection)
  const row = (await db(collection)
    .where('id', id as never)
    .first(selectable)) as Record<string, unknown> | undefined
  if (!row) return null
  const findings = await evaluateRows(checks, [row], physical, liveCache())
  return { findings, ms: Date.now() - t0 }
}

/**
 * Do the three integrity writers agree? (#529)
 *
 * Findings are written by the after-write hook, the on-load live check and
 * the collection sweep, then reconciled into the latest run's rows. The
 * reconciliation exists because they COULD diverge — the live path compiles
 * checks through a 5-minute stale-while-revalidate cache and a 60s row-rule
 * lookup cache; the sweep compiles fresh and keeps a per-chunk cache. All
 * three share `evaluateRows`, so the only possible disagreement is stale
 * compiled config or stale lookups. This runs BOTH paths — cached-live and
 * fresh-sweep — over the same rows and reports every finding one produced
 * and the other did not, per collection. Empty = they agree right now.
 */
export async function compareIntegrityWriters(opts: { perCollection?: number } = {}): Promise<{
  collections: number
  records: number
  findings_live: number
  findings_sweep: number
  disagreements: Array<{
    collection: string
    item_id: string
    field: string
    rule: string
    only_in: 'live' | 'sweep'
  }>
}> {
  const per = Math.max(1, Math.min(200, opts.perCollection ?? 20))
  const layouts = (await db('nivaro_collection_layouts')
    .where('layout_type', 'grouped')
    .where('is_active', true)
    .distinct('collection')) as Array<{ collection: string }>
  const out = {
    collections: 0,
    records: 0,
    findings_live: 0,
    findings_sweep: 0,
    disagreements: [] as Array<{
      collection: string
      item_id: string
      field: string
      rule: string
      only_in: 'live' | 'sweep'
    }>
  }
  const key = (f: RecordFinding) => `${f.item_id}|${f.field}|${f.rule}`
  for (const { collection } of layouts) {
    if (!(await hasChecks(collection).catch(() => false))) continue
    const live = await compileChecksCached(collection)
    const fresh = await buildCompiled(collection)
    // Select the union of both bundles' columns so neither path is starved.
    const selectable = [...new Set([...live.selectable, ...fresh.selectable])]
    const rows = (await db(collection)
      .orderBy('id', 'desc')
      .limit(per)
      .select(selectable)) as Array<Record<string, unknown>>
    if (rows.length === 0) continue
    out.collections++
    out.records += rows.length
    const a = await evaluateRows(live.checks, rows, live.physical, liveCache())
    const b = await evaluateRows(fresh.checks, rows, fresh.physical, new RowRuleLookupCache(db))
    out.findings_live += a.length
    out.findings_sweep += b.length
    const setA = new Set(a.map(key))
    const setB = new Set(b.map(key))
    for (const f of a)
      if (!setB.has(key(f)))
        out.disagreements.push({
          collection,
          item_id: String(f.item_id),
          field: f.field,
          rule: f.rule,
          only_in: 'live'
        })
    for (const f of b)
      if (!setA.has(key(f)))
        out.disagreements.push({
          collection,
          item_id: String(f.item_id),
          field: f.field,
          rule: f.rule,
          only_in: 'sweep'
        })
  }
  return out
}

/**
 * Persist a record's live result: the per-record row the banner reads
 * (nivaro_record_integrity — the "never stale" store, written by the write
 * hook and the on-load check) AND the latest completed sweep's rows for the
 * record, so the Data Integrity page agrees with the form.
 */
export async function storeRecordResult(
  collection: string,
  id: string,
  findings: RecordFinding[],
  source: 'write' | 'live' | 'sweep'
): Promise<void> {
  const now = new Date()
  const payload = JSON.stringify(
    findings.map((f) => ({ field: f.field, rule: f.rule, message: f.message.slice(0, 1000) }))
  )
  const updated = await db('nivaro_record_integrity')
    .where({ collection, item_id: String(id) })
    .update({ findings: payload, checked_at: now, source })
  if (!updated) {
    await db('nivaro_record_integrity')
      .insert({ collection, item_id: String(id), findings: payload, checked_at: now, source })
      .catch(async () => {
        // Lost a race with a concurrent insert — the update path wins.
        await db('nivaro_record_integrity')
          .where({ collection, item_id: String(id) })
          .update({ findings: payload, checked_at: now, source })
      })
  }
  const run = (await db('nivaro_conformance_runs')
    .where({ collection, status: 'completed' })
    .orderBy('id', 'desc')
    .first('id')) as { id: number } | undefined
  if (!run) return
  const stale = (await db('nivaro_conformance_findings')
    .where({ run: run.id, item_id: String(id) })
    .count({ n: '*' })
    .first()) as { n: number | string } | undefined
  const staleN = Number(stale?.n ?? 0)
  await db('nivaro_conformance_findings')
    .where({ run: run.id, item_id: String(id) })
    .del()
  if (findings.length > 0) {
    const labels = await getLabels(new Map([[collection, new Set([String(id)])]])).catch(
      () => ({}) as Record<string, string>
    )
    await db('nivaro_conformance_findings').insert(
      findings.map((f) => ({
        run: run.id,
        item_id: f.item_id,
        item_label: (labels[`${collection}:${f.item_id}`] ?? null)?.slice(0, 500) ?? null,
        field: f.field,
        rule: f.rule,
        message: f.message.slice(0, 1000)
      }))
    )
  }
  const delta = findings.length - staleN
  if (delta !== 0) {
    await db('nivaro_conformance_runs')
      .where('id', run.id)
      .update({
        violation_count: db.raw(
          'CASE WHEN violation_count + ? < 0 THEN 0 ELSE violation_count + ? END',
          [delta, delta]
        )
      })
      .catch(() => {})
  }
}

/** The stored per-record result, when one exists. */
export async function readRecordResult(
  collection: string,
  id: string
): Promise<{ findings: RecordFinding[]; checked_at: Date; source: string } | null> {
  const row = (await db('nivaro_record_integrity')
    .where({ collection, item_id: String(id) })
    .first('findings', 'checked_at', 'source')
    .catch(() => undefined)) as { findings: string; checked_at: Date; source: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.findings) as Array<Omit<RecordFinding, 'item_id'>>
    return {
      findings: parsed.map((f) => ({ ...f, item_id: String(id) })),
      checked_at: row.checked_at,
      source: row.source
    }
  } catch {
    return null
  }
}

async function evaluate(
  runId: number,
  checks: CompiledChecks,
  rowCap: number
): Promise<ConformanceSummary> {
  const { collection } = checks
  const { physical, selectable } = await columnsFor(checks)

  let checked = 0
  let violations = 0
  let truncated = false
  let lastId: unknown = null
  // Full-fidelity totals — every violation counts here even after the
  // stored-findings cap, so the facet chips always describe the whole run.
  const ruleCounts = new Map<string, number>()
  const fieldCounts = new Map<string, number>()

  while (checked < rowCap) {
    const rows = (await db(collection)
      .modify((qb) => {
        if (lastId != null) qb.where('id', '<', lastId as never)
      })
      .orderBy('id', 'desc')
      .limit(Math.min(CHUNK, rowCap - checked))
      .select(selectable)) as Array<Record<string, unknown>>
    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id
    checked += rows.length

    const findings = await evaluateRows(checks, rows, physical)

    // ── persist chunk findings with labels — EVERY finding stores; the
    // detail is the point, and the rows are small ────────────────────────
    for (const f of findings) {
      ruleCounts.set(f.rule, (ruleCounts.get(f.rule) ?? 0) + 1)
      fieldCounts.set(f.field, (fieldCounts.get(f.field) ?? 0) + 1)
    }
    if (findings.length > 0) {
      violations += findings.length
      const ids = [...new Set(findings.map((f) => f.item_id))]
      const labels = await getLabels(new Map([[collection, new Set(ids)]])).catch(
        () => ({}) as Record<string, string>
      )
      const inserts = findings.map((f) => ({
        run: runId,
        item_id: f.item_id,
        item_label: (labels[`${collection}:${f.item_id}`] ?? null)?.slice(0, 500) ?? null,
        field: f.field,
        rule: f.rule,
        message: f.message.slice(0, 1000)
      }))
      // MSSQL caps bound parameters at ~2100 — 6 columns per row means a
      // whole-chunk insert can blow it when most rows violate.
      for (let i = 0; i < inserts.length; i += 200) {
        await db('nivaro_conformance_findings').insert(inserts.slice(i, i + 200))
      }
    }

    // Progress is visible to pollers without waiting for the end.
    await db('nivaro_conformance_runs')
      .where('id', runId)
      .update({
        checked_records: checked,
        violation_count: violations,
        rule_counts: JSON.stringify(Object.fromEntries(ruleCounts)),
        field_counts: JSON.stringify(Object.fromEntries(fieldCounts))
      })
      .catch(() => {})

    if (rows.length < CHUNK) break
  }
  if (checked >= rowCap) truncated = true
  return {
    checked,
    violations,
    truncated,
    ruleCounts: Object.fromEntries(ruleCounts),
    fieldCounts: Object.fromEntries(fieldCounts)
  }
}

/**
 * One parent chunk of the row-rule check: fetch every child row of the chunk
 * in bulk, re-derive every rule target from scratch (the grid's "all" mode —
 * a rule deriving nothing never counts as drift), and report one finding per
 * line naming each stored-vs-derived disagreement. FK values are shown as
 * labels so "Task is X — rules derive Y" reads like the form does.
 */
async function evaluateRowRuleCheck(
  rc: RowRuleCheck,
  parents: Array<Record<string, unknown>>,
  sharedCache?: RowRuleLookupCache
): Promise<Array<{ item_id: string; field: string; rule: string; message: string }>> {
  const out: Array<{ item_id: string; field: string; rule: string; message: string }> = []
  const parentIds = parents.map((p) => String(p.id))
  const children = await selectInChunks(
    parentIds,
    1000,
    (ids) =>
      db(rc.childCollection).whereIn(rc.fkField, ids).orderBy('id').select('*') as Promise<
        Array<Record<string, unknown>>
      >
  )
  if (children.length === 0) return out
  const byParent = new Map<string, Array<Record<string, unknown>>>()
  for (const c of children) {
    const k = String(c[rc.fkField])
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k)?.push(c)
  }
  // One lookup cache per chunk: relation metadata + related records are
  // shared across every line of every parent in the chunk, bounded in size.
  // The live per-record path hands in a short-lived process cache instead.
  const cache = sharedCache ?? new RowRuleLookupCache(db)
  type Drift = {
    parentId: string
    line: Record<string, unknown>
    diffs: Array<{ field: string; was: unknown; now: unknown; locked: boolean }>
  }
  const drifts: Drift[] = []
  for (const parent of parents) {
    const lines = byParent.get(String(parent.id))
    if (!lines || lines.length === 0) continue
    const plan = await planRowRuleChanges({
      collection: rc.childCollection,
      rows: lines,
      parentContext: parentContextFrom(rc, parent),
      rules: rc.rowRules,
      mode: 'all',
      cache
    })
    // Lines whose rule INPUTS are empty: a category-less workflow line has no
    // basis for its task / Oracle category / PO line type at all — the
    // real defect is the missing category, not whichever value sits in the
    // targets. Reported separately (rule 'row-input'), never auto-fixed.
    for (const line of lines) {
      const missing = new Map<string, Set<string>>()
      // A trigger the rules themselves DERIVE for this line (a project's
      // default category) is a row-rule drift, not a missing input.
      const derivedHere = new Set(
        Object.keys(plan.changes.find((c) => c.id === String(line.id))?.patch ?? {})
      )
      for (const rule of rc.rowRules) {
        const tf = rule.trigger_field
        if (!tf || tf.startsWith('$parent.') || rule.target_type === 'lock') continue
        if ((rule.trigger_op ?? 'nnull') === 'null') continue
        if (derivedHere.has(tf)) continue
        const v = line[tf]
        if (v != null && v !== '') continue
        if (!missing.has(tf)) missing.set(tf, new Set())
        missing.get(tf)?.add(rule.target_field)
      }
      for (const [tf, targets] of missing) {
        const lineNo = rc.lineField ? line[rc.lineField] : null
        const head =
          lineNo != null && lineNo !== '' ? `Line ${String(lineNo)}` : `Line #${String(line.id)}`
        const names = [...targets].map((t) => rc.childFields.get(t)?.label ?? label(t))
        out.push({
          item_id: String(parent.id),
          field: rc.aliasField,
          rule: 'row-input',
          message: `${head}: ${rc.childFields.get(tf)?.label ?? label(tf)} is empty — ${names.join(', ')} cannot be derived until it is set`
        })
      }
    }
    for (const ch of plan.changes) {
      const line = lines.find((l) => String(l.id) === ch.id)
      if (!line) continue
      drifts.push({
        parentId: String(parent.id),
        line,
        diffs: Object.keys(ch.patch).map((f) => ({
          field: f,
          was: ch.before[f],
          now: ch.patch[f],
          locked: ch.locked.includes(f)
        }))
      })
    }
  }
  if (drifts.length === 0) return out

  // Resolve FK ids → labels in one batch per related collection.
  const wanted = new Map<string, Set<string>>()
  for (const d of drifts) {
    for (const diff of d.diffs) {
      const rel = rc.childFields.get(diff.field)?.relatedCollection
      if (!rel) continue
      for (const v of [diff.was, diff.now]) {
        if (v == null || v === '') continue
        if (!wanted.has(rel)) wanted.set(rel, new Set())
        wanted.get(rel)?.add(String(v))
      }
    }
  }
  const labels =
    wanted.size > 0 ? await getLabels(wanted).catch(() => ({}) as Record<string, string>) : {}
  const fmt = (field: string, v: unknown): string => {
    if (v == null || v === '') return 'empty'
    const meta = rc.childFields.get(field)
    if (meta?.relatedCollection) {
      const l = labels[`${meta.relatedCollection}:${String(v)}`]
      return l ? `"${l}"` : `#${String(v)}`
    }
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n) && String(v).trim() !== '') {
      if (meta?.currency) return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
    }
    return `"${String(v)}"`
  }
  for (const d of drifts) {
    const lineNo = rc.lineField ? d.line[rc.lineField] : null
    const head =
      lineNo != null && lineNo !== '' ? `Line ${String(lineNo)}` : `Line #${String(d.line.id)}`
    const parts = d.diffs.map((diff) => {
      const lbl = rc.childFields.get(diff.field)?.label ?? label(diff.field)
      return `${lbl} is ${fmt(diff.field, diff.was)} — rules derive ${fmt(diff.field, diff.now)}${diff.locked ? ' (locked)' : ''}`
    })
    out.push({
      item_id: d.parentId,
      field: rc.aliasField,
      rule: 'row-rule',
      message: `${head}: ${parts.join('; ')}`
    })
  }
  return out
}

/**
 * Validation-rule change impact: evaluate CURRENT vs PROPOSED rules for one
 * field over the newest rows and report the flips. Same evaluator the save
 * path uses; date-offset rules judged against the creation date exactly like
 * the sweep (records age past "N days from today" naturally — entry-time is
 * the honest historical reading).
 */
export async function previewValidationImpact(
  collection: string,
  field: string,
  opts: { proposedRules: ValidationRule[]; proposedRequired: boolean; limit: number }
): Promise<{
  scanned: number
  current_failing: number
  proposed_failing: number
  newly_failing: number
  newly_passing: number
  samples: Array<{ id: string | number; label: string; message: string }>
}> {
  if (!(await hasPhysicalColumn(collection, field))) {
    throw new Error('Impact preview supports physical columns only (not M2M aliases)')
  }
  const creationBaseline = (await hasPhysicalColumn(collection, 'date_created'))
    ? 'date_created'
    : (await hasPhysicalColumn(collection, 'created_at'))
      ? 'created_at'
      : null

  const fieldRow = (await db('nivaro_fields')
    .where({ collection, field })
    .first('validation_rules', 'required')) as
    | { validation_rules: string | null; required: boolean | number | null }
    | undefined
  const currentRules = parseJson<ValidationRule[]>(fieldRow?.validation_rules) ?? []
  const currentRequired = fieldRow?.required === true || fieldRow?.required === 1

  const evalRules = (
    rules: ValidationRule[],
    required: boolean,
    value: unknown,
    createdAt: unknown
  ): string | null => {
    if (required) {
      const msg = applyValidationRule({ type: 'required' }, value, field)
      if (msg) return msg
    }
    for (const r of Array.isArray(rules) ? rules : []) {
      if (r.type === 'min_days_from_today' || r.type === 'max_days_from_today') {
        const days = Number(r.value)
        if (!creationBaseline || !Number.isFinite(days)) continue
        if (value == null || value === '' || createdAt == null) continue
        const v = new Date(String(value)).getTime()
        const base = new Date(String(createdAt)).getTime() + days * 86_400_000
        if (Number.isNaN(v) || Number.isNaN(base)) continue
        const fails = r.type === 'min_days_from_today' ? v < base : v > base
        if (fails) {
          return (
            r.message ||
            `${field} must be at ${r.type === 'min_days_from_today' ? 'least' : 'most'} ${days} day(s) out (judged at entry)`
          )
        }
        continue
      }
      const msg = applyValidationRule(r, value, field)
      if (msg) return msg
    }
    return null
  }

  const cols = creationBaseline ? ['id', field, creationBaseline] : ['id', field]
  const rows = (await db(collection).select(cols).orderBy('id', 'desc').limit(opts.limit)) as Array<
    Record<string, unknown>
  >

  let currentFailing = 0
  let proposedFailing = 0
  const newly: Array<{ id: string | number; message: string }> = []
  let newlyPassing = 0
  for (const row of rows) {
    const created = creationBaseline ? row[creationBaseline] : null
    const cur = evalRules(currentRules, currentRequired, row[field], created)
    const prop = evalRules(opts.proposedRules, opts.proposedRequired, row[field], created)
    if (cur) currentFailing++
    if (prop) proposedFailing++
    if (!cur && prop) newly.push({ id: row.id as string | number, message: prop })
    if (cur && !prop) newlyPassing++
  }

  const sampleIds = newly.slice(0, 10).map((n) => String(n.id))
  let labels: Record<string, string> = {}
  try {
    labels = await getLabels(new Map([[collection, new Set(sampleIds)]]))
  } catch {
    // labels are garnish
  }
  return {
    scanned: rows.length,
    current_failing: currentFailing,
    proposed_failing: proposedFailing,
    newly_failing: newly.length,
    newly_passing: newlyPassing,
    samples: newly.slice(0, 10).map((n) => ({
      id: n.id,
      label: labels[`${collection}:${n.id}`] ?? String(n.id),
      message: n.message
    }))
  }
}
