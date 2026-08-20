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
const FINDINGS_CAP = 2000

interface CascadeCheck {
  field: string
  parent_field: string
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

interface CompiledChecks {
  collection: string
  requiredFields: RequiredCheck[]
  validation: Array<{ field: string; label: string; rules: ValidationRule[] }>
  cascades: CascadeCheck[]
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
  const layouts = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped' })
    .select('id', 'name')) as Array<{ id: number; name: string }>
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
    .select('field', 'required', 'validation_rules', 'dependency_config')) as Array<{
    field: string
    required: unknown
    validation_rules: unknown
    dependency_config: unknown
  }>

  const out: CompiledChecks = {
    collection,
    requiredFields: [],
    validation: [],
    cascades: [],
    skipped: []
  }
  const { layouts, visibleOn } = await layoutPresence(collection)

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
            ? { field: f.field, label: label(f.field), kind: 'm2m', junction: alias }
            : { field: f.field, label: label(f.field), kind: 'column' }
        )
      }
    }
    const rules = parseJson<ValidationRule[]>(f.validation_rules)
    if (Array.isArray(rules) && rules.length > 0) {
      const presence = onEveryLayout(f.field)
      if (!presence.ok) {
        out.skipped.push(
          `${f.field}: validation rules, but layout-dependent (not on ${presence.missing.join(', ')})`
        )
      } else {
        out.validation.push({ field: f.field, label: label(f.field), rules })
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
        parent_field: c.parent_field,
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
          findings.push({
            item_id: String(row.id),
            field: c.field,
            rule: 'cascade',
            message: c.childIsM2M
              ? `${bad.length} linked ${label(c.field)} value(s) are not available options for the current ${label(c.parent_field)}`
              : `${label(c.field)} value is not an available option for the current ${label(c.parent_field)}`
          })
        }
      }
    }

    // ── persist chunk findings with labels ───────────────────────────────
    if (findings.length > 0) {
      const remaining = FINDINGS_CAP - violations
      const keep = findings.slice(0, Math.max(0, remaining))
      violations += findings.length
      if (keep.length > 0) {
        const ids = [...new Set(keep.map((f) => f.item_id))]
        const labels = await getLabels(new Map([[collection, new Set(ids)]])).catch(
          () => ({}) as Record<string, string>
        )
        const inserts = keep.map((f) => ({
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
      // Past the findings cap we stop PERSISTING but keep counting — an
      // unlimited run's violation total must describe the whole collection,
      // not the first 2,000 rows that happened to store.
      if (violations >= FINDINGS_CAP) truncated = true
    }

    // Progress is visible to pollers without waiting for the end.
    await db('nivaro_conformance_runs')
      .where('id', runId)
      .update({ checked_records: checked, violation_count: violations })
      .catch(() => {})

    if (rows.length < CHUNK) break
  }
  if (checked >= rowCap) truncated = true
  return { checked, violations, truncated }
}
