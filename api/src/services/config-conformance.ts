import { db } from '../db/index.js'
import { getLabels } from './queues.js'
import { type ValidationRule, applyValidationRule } from './validation-rules.js'

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

interface CascadeCheck {
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

interface CompiledChecks {
  collection: string
  requiredFields: RequiredCheck[]
  validation: Array<{ field: string; label: string; rules: ValidationRule[] }>
  dateOffsets: DateOffsetCheck[]
  cascades: CascadeCheck[]
  /** Display-template parts — a record whose parts all resolve empty renders
   *  as its internal id everywhere labels are used. */
  displayTokens: DisplayToken[]
  /** Rules present in config but not evaluable by this sweep. */
  skipped: string[]
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

const label = (field: string) => field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

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
    .select('field', 'label', 'required', 'validation_rules', 'dependency_config')) as Array<{
    field: string
    label: string | null
    required: unknown
    validation_rules: unknown
    dependency_config: unknown
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
    displayTokens: [],
    dateOffsets: [],
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
  const meta = (await db('nivaro_collections')
    .where({ collection })
    .first('display_template')) as { display_template: string | null } | undefined
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
      // columns that are aliases (workflows.project_type filtering
      // project_types.divisions was the live example).
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
  return out
}

export interface CollectionCheckSummary {
  collection: string
  required: number
  validation: number
  cascade: number
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
      )
      .select('collection', 'field', 'required', 'validation_rules', 'dependency_config') as Promise<
      Array<{
        collection: string
        field: string
        required: unknown
        validation_rules: unknown
        dependency_config: unknown
      }>
    >,
    db('nivaro_collection_layouts')
      .where('layout_type', 'grouped')
      // Same reachability rule as layoutPresence — the two must not drift.
      .where((qb) =>
        qb.where('is_active', true).orWhere((q2) => q2.whereNotNull('slug').where('create_hidden', false))
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
      e = { collection, required: 0, validation: 0, cascade: 0, skipped: 0 }
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
      cascade_filters?: Array<{ parent_field?: string; filter_column?: string; filter_via_many?: boolean }>
    }>(f.dependency_config)
    for (const c of dep?.cascade_filters ?? []) {
      if (!c.parent_field || !c.filter_column) continue
      if (c.filter_column.includes('.') || c.filter_via_many) e.skipped++
      else e.cascade++
    }
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
    await db('nivaro_conformance_runs').where('id', runId).update({
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

async function evaluate(
  runId: number,
  checks: CompiledChecks,
  rowCap: number
): Promise<ConformanceSummary> {
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
  for (const t of checks.displayTokens) {
    columns.add(t.hops.length > 0 ? t.hops[0].fk : t.leaf)
  }
  for (const d of checks.dateOffsets) {
    columns.add(d.field)
    columns.add(d.baseline)
  }
  // Only real columns survive — required flags on alias fields (M2M pickers)
  // have no scalar column to test here.
  const physical = new Set(
    (
      (await db.raw(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`,
        [collection]
      )) as Array<{ COLUMN_NAME: string }>
    ).map((c) => c.COLUMN_NAME)
  )
  const selectable = [...columns].filter((c) => physical.has(c))

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

    const findings: Array<{ item_id: string; field: string; rule: string; message: string }> = []

    // ── required + validation, plain JS per row ──────────────────────────
    for (const row of rows) {
      for (const r of checks.requiredFields) {
        if (r.kind !== 'column' || !physical.has(r.field)) continue
        const msg = applyValidationRule({ type: 'required' }, row[r.field], r.label)
        if (msg) findings.push({ item_id: String(row.id), field: r.field, rule: 'required', message: msg })
      }
      for (const v of checks.validation) {
        if (!physical.has(v.field)) continue
        for (const rule of v.rules) {
          const msg = applyValidationRule(rule, row[v.field], v.label)
          if (msg) {
            findings.push({ item_id: String(row.id), field: v.field, rule: 'validation', message: msg })
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
          findings.push({
            item_id: String(row.id),
            field: d.field,
            rule: 'validation',
            message: `${d.label} was ${diff} day(s) from creation — the rule required at ${d.op === 'min' ? 'least' : 'most'} ${d.days}`
          })
        }
      }
    }

    // ── required M2M aliases: zero junction rows = empty ─────────────────
    for (const r of checks.requiredFields) {
      if (r.kind !== 'm2m' || !r.junction) continue
      // NOTE: .distinct(col).select(col) doubles the column on mssql and the
      // value comes back as a nested array (the chat-DM .pluck trap) — plain
      // .distinct(col) alone selects it correctly.
      const linked = new Set(
        (
          (await db(r.junction.table)
            .whereIn(r.junction.srcFk, rows.map((x) => x.id) as never[])
            .distinct(r.junction.srcFk)) as Array<Record<string, unknown>>
        ).map((l) => String(l[r.junction?.srcFk ?? '']))
      )
      for (const row of rows) {
        if (!linked.has(String(row.id))) {
          findings.push({
            item_id: String(row.id),
            field: r.field,
            rule: 'required',
            message: `${r.label} has no linked records`
          })
        }
      }
    }

    // ── cascade availability, batched per rule ───────────────────────────
    // A field with several cascade rules (unit: by project type, unit type
    // AND install location) reports ONE finding per record listing every
    // failing parent, not one row per rule.
    const cascadeFails = new Map<
      string,
      { field: string; fieldLabel: string; isM2M: boolean; badCount: number; parents: string[] }
    >()
    for (const c of checks.cascades) {
      if (!c.childIsM2M && !physical.has(c.field)) continue
      const rowIds = rows.map((r) => r.id)

      // Child value(s) per row: a plain M2O reads the column; an M2M alias
      // reads its junction set (each linked id must be available).
      const childSets = new Map<string, Set<string>>()
      if (c.childIsM2M && c.childJunction) {
        const links = (await db(c.childJunction.table)
          .whereIn(c.childJunction.srcFk, rowIds as never[])
          .select(c.childJunction.srcFk, c.childJunction.tgtFk)) as Array<
          Record<string, unknown>
        >
        for (const l of links) {
          const key = String(l[c.childJunction.srcFk])
          if (!childSets.has(key)) childSets.set(key, new Set())
          childSets.get(key)?.add(String(l[c.childJunction.tgtFk]))
        }
      } else {
        for (const row of rows) {
          const v = row[c.field]
          if (v != null && v !== '') childSets.set(String(row.id), new Set([String(v)]))
        }
      }

      // Parent value set per row.
      const parentSets = new Map<string, Set<string>>()
      if (c.parentIsM2M && c.parentJunction) {
        const links = (await db(c.parentJunction.table)
          .whereIn(c.parentJunction.srcFk, rowIds as never[])
          .select(c.parentJunction.srcFk, c.parentJunction.tgtFk)) as Array<
          Record<string, unknown>
        >
        for (const l of links) {
          const key = String(l[c.parentJunction.srcFk])
          if (!parentSets.has(key)) parentSets.set(key, new Set())
          parentSets.get(key)?.add(String(l[c.parentJunction.tgtFk]))
        }
      } else if (physical.has(c.parent_field)) {
        for (const row of rows) {
          const pv = row[c.parent_field]
          if (pv != null && pv !== '') parentSets.set(String(row.id), new Set([String(pv)]))
        }
      }

      // Availability of the DISTINCT child values under each parent.
      const childVals = [...new Set([...childSets.values()].flatMap((set) => [...set]))]
      if (childVals.length === 0) continue
      // childValue → the set of parent values it is available under
      const availability = new Map<string, Set<string>>()
      if (c.filterIsM2M && c.filterJunction) {
        const links = (await db(c.filterJunction.table)
          .whereIn(c.filterJunction.srcFk, childVals as never[])
          .select(c.filterJunction.srcFk, c.filterJunction.tgtFk)) as Array<
          Record<string, unknown>
        >
        for (const l of links) {
          const key = String(l[c.filterJunction.srcFk])
          if (!availability.has(key)) availability.set(key, new Set())
          availability.get(key)?.add(String(l[c.filterJunction.tgtFk]))
        }
      } else {
        const targets = (await db(c.target)
          .whereIn('id', childVals as never[])
          .select('id', c.filter_column)) as Array<Record<string, unknown>>
        for (const t of targets) {
          const fv = t[c.filter_column]
          availability.set(String(t.id), fv == null ? new Set() : new Set([String(fv)]))
        }
      }

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
        })
        if (bad.length > 0) {
          const key = `${row.id}|${c.field}`
          let agg = cascadeFails.get(key)
          if (!agg) {
            agg = { field: c.field, fieldLabel: c.fieldLabel, isM2M: c.childIsM2M, badCount: 0, parents: [] }
            cascadeFails.set(key, agg)
          }
          agg.badCount = Math.max(agg.badCount, bad.length)
          agg.parents.push(c.parentLabel)
        }
      }
    }

    for (const [key, agg] of cascadeFails) {
      const rowId = key.slice(0, key.length - agg.field.length - 1)
      const parents =
        agg.parents.length > 1
          ? `${agg.parents.slice(0, -1).join(', ')} or ${agg.parents[agg.parents.length - 1]}`
          : agg.parents[0]
      findings.push({
        item_id: rowId,
        field: agg.field,
        rule: 'cascade',
        message: agg.isM2M
          ? `${agg.badCount} linked ${agg.fieldLabel} value(s) are not available options for the current ${parents}`
          : `${agg.fieldLabel} value is not an available option for the current ${parents}`
      })
    }

    // ── display template completeness, hops batch-resolved per level ─────
    if (checks.displayTokens.length > 0) {
      const emptyParts = new Map<string, string[]>()
      for (const t of checks.displayTokens) {
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
        for (const [rowId, v] of values) {
          if (v == null || String(v).trim() === '') {
            if (!emptyParts.has(rowId)) emptyParts.set(rowId, [])
            emptyParts.get(rowId)?.push(t.raw)
          }
        }
      }
      for (const [rowId, parts] of emptyParts) {
        findings.push({
          item_id: rowId,
          field: parts[0].split('.')[0],
          rule: 'display',
          message: `Display template part(s) empty: ${parts.map((p) => `{{${p}}}`).join(', ')} — the record shows as its internal id`
        })
      }
    }

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
