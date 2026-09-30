import { db } from '../db/index.js'
import { evaluateRowRules, type RowRule, RowRuleLookupCache } from './field-rules.js'
import { parseRowLints, type RowLint } from './row-lints.js'

/**
 * Row-rule re-derivation, shared by the grid's "re-run rules" endpoint
 * (`POST /field-rules/apply`), the Data Integrity row-rule sweep, and the
 * record-banner / run-level fixes. One planner so the four surfaces cannot
 * disagree about what "the rules derive" means for a saved line.
 */

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

export interface GridRuleConfig {
  /** The grid's assignment field on the parent layout — the O2M alias, or
   *  the child table's own name for a second grid on the same relation. */
  aliasField: string
  /** Assignment label (overrides.label / label_override) or null. */
  label: string | null
  layoutId: number
  parentCollection: string
  childCollection: string
  fkField: string
  rowRules: RowRule[]
  parentContextFields: string[]
}

/**
 * Every grid on the parent's ACTIVE grouped layout that carries row rules —
 * the same layout the API autofill (row-rules-autofill.ts) enforces. A grid
 * whose field resolves to no O2M relation is skipped.
 */
export async function gridRuleConfigsFor(parentCollection: string): Promise<GridRuleConfig[]> {
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection: parentCollection, layout_type: 'grouped', is_active: true })
    .first('id')) as { id: number } | undefined
  if (!layout) return []
  const rows = (await db('nivaro_layout_field_assignments')
    .where('layout_id', layout.id)
    .whereRaw("overrides LIKE '%row_rules%'")
    .select('field', 'label_override', 'overrides')) as Array<{
    field: string
    label_override: string | null
    overrides: string | null
  }>
  if (rows.length === 0) return []
  const rels = (await db('nivaro_relations')
    .where('one_collection', parentCollection)
    .whereNull('junction_field')
    .select('one_field', 'many_collection', 'many_field')) as Array<{
    one_field: string | null
    many_collection: string
    many_field: string
  }>
  const out: GridRuleConfig[] = []
  for (const row of rows) {
    const overrides = parseJson<{ label?: string; options?: Record<string, unknown> }>(
      row.overrides
    )
    const opts = overrides?.options
    const rowRules = (Array.isArray(opts?.row_rules) ? (opts.row_rules as RowRule[]) : []).filter(
      (r) => r && typeof r.target_field === 'string'
    )
    if (rowRules.length === 0) continue
    const rel = rels.find((r) => r.one_field === row.field || r.many_collection === row.field)
    if (!rel) continue
    out.push({
      aliasField: row.field,
      label: overrides?.label || row.label_override || null,
      layoutId: layout.id,
      parentCollection,
      childCollection: rel.many_collection,
      fkField: rel.many_field,
      rowRules,
      parentContextFields: Array.isArray(opts?.parent_context_fields)
        ? (opts.parent_context_fields as string[])
        : []
    })
  }
  return out
}

export interface GridLintConfig {
  aliasField: string
  label: string | null
  layoutId: number
  parentCollection: string
  childCollection: string
  fkField: string
  lints: RowLint[]
}

/** Grids on the ACTIVE grouped layout carrying `options.row_lints` (#766). */
export async function gridLintConfigsFor(parentCollection: string): Promise<GridLintConfig[]> {
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection: parentCollection, layout_type: 'grouped', is_active: true })
    .first('id')) as { id: number } | undefined
  if (!layout) return []
  const rows = (await db('nivaro_layout_field_assignments')
    .where('layout_id', layout.id)
    .whereRaw("overrides LIKE '%row_lints%'")
    .select('field', 'label_override', 'overrides')) as Array<{
    field: string
    label_override: string | null
    overrides: string | null
  }>
  if (rows.length === 0) return []
  const rels = (await db('nivaro_relations')
    .where('one_collection', parentCollection)
    .whereNull('junction_field')
    .select('one_field', 'many_collection', 'many_field')) as Array<{
    one_field: string | null
    many_collection: string
    many_field: string
  }>
  const out: GridLintConfig[] = []
  for (const row of rows) {
    const overrides = parseJson<{ label?: string; options?: Record<string, unknown> }>(
      row.overrides
    )
    const lints = parseRowLints(overrides?.options?.row_lints)
    if (lints.length === 0) continue
    const rel = rels.find((r) => r.one_field === row.field || r.many_collection === row.field)
    if (!rel) continue
    out.push({
      aliasField: row.field,
      label: overrides?.label || row.label_override || null,
      layoutId: layout.id,
      parentCollection,
      childCollection: rel.many_collection,
      fkField: rel.many_field,
      lints
    })
  }
  return out
}

/** Parent columns the grid's rules read: configured context fields plus every
 *  `$parent.<field>` trigger. */
export function parentFieldsFor(
  cfg: Pick<GridRuleConfig, 'rowRules' | 'parentContextFields'>
): string[] {
  const wanted = new Set(cfg.parentContextFields)
  for (const rule of cfg.rowRules) {
    const tf = rule.trigger_field
    if (typeof tf === 'string' && tf.startsWith('$parent.')) wanted.add(tf.slice(8))
    for (const t of rule.trigger_fields ?? []) {
      if (typeof t === 'string' && t.startsWith('$parent.')) wanted.add(t.slice(8))
    }
    // Precedence sources read parent columns too: parent_m2o sources by their
    // source_field, and `when` gates on a $parent field.
    for (const src of rule.sources ?? []) {
      if (src.source_type === 'parent_m2o' && src.source_field) wanted.add(src.source_field)
      const wf = src.when?.field
      if (typeof wf === 'string' && wf.startsWith('$parent.')) wanted.add(wf.slice(8))
    }
  }
  return [...wanted]
}

export function parentContextFrom(
  cfg: Pick<GridRuleConfig, 'rowRules' | 'parentContextFields'>,
  parentRow: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {}
  if (!parentRow) return ctx
  for (const f of parentFieldsFor(cfg)) ctx[f] = parentRow[f] ?? null
  return ctx
}

export interface RowRuleChange {
  id: string
  patch: Record<string, unknown>
  before: Record<string, unknown>
  /** Targets the rules LOCK on this row (subset of patch keys may be locked). */
  locked: string[]
}

export interface RowRulePlan {
  rows: number
  fields: Record<string, number>
  changes: RowRuleChange[]
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

/**
 * Plan what re-running the rules would change on the given child rows.
 *
 *   - `empty-only`: only fill targets that are empty (plus targets a lock
 *     rule owns on that row — nobody could have typed those).
 *   - `all`: blank every non-lock target and re-derive; a rule that derives
 *     NOTHING never erases an existing value.
 *
 * Nothing is written. Callers apply `changes` through updateOne.
 */
export async function planRowRuleChanges(opts: {
  collection: string
  rows: Array<Record<string, unknown>>
  parentContext: Record<string, unknown>
  rules: RowRule[]
  mode: 'empty-only' | 'all'
  cache?: RowRuleLookupCache
}): Promise<RowRulePlan> {
  const rules = opts.rules.filter((r) => r && typeof r.target_field === 'string')
  // Every non-lock target is judged for drift; only targets that some
  // NON-seed rule DERIVES A VALUE for are blanked for re-derivation — a
  // seed_only target (default category / default item) is an input the rules
  // fill when empty, never one they own, and a `clear` rule derives nothing:
  // it only empties its target on the rows it matches. Blanking a target
  // because a clear rule names it would hand a hand-picked value back to the
  // seed rules, which then "correct" it to the default — the seed rules'
  // own still-auto check is what decides whether an existing value re-derives.
  const targets = new Set(rules.filter((r) => r.target_type !== 'lock').map((r) => r.target_field))
  const derivable = new Set(
    rules
      .filter((r) => r.target_type !== 'lock' && r.target_type !== 'clear' && !r.seed_only)
      .map((r) => r.target_field)
  )
  const plan: RowRulePlan = { rows: opts.rows.length, fields: {}, changes: [] }
  if (targets.size === 0) return plan
  const cache = opts.cache ?? new RowRuleLookupCache(db)
  const hasLocks = rules.some((r) => r.target_type === 'lock')
  for (const row of opts.rows) {
    const locked = new Set<string>()
    // Fill-blanks mode needs the locks BEFORE deciding what to null (a lock
    // rule owns its target, so even a filled value is re-derived); 'all'
    // mode nulls every target anyway and collects locks on the single pass.
    if (hasLocks && opts.mode === 'empty-only') {
      await evaluateRowRules(
        db,
        opts.collection,
        { ...row },
        opts.parentContext,
        rules,
        undefined,
        {
          cache,
          locks: locked,
          locksOnly: true
        }
      )
    }
    const working: Record<string, unknown> = { ...row }
    if (opts.mode === 'all') for (const t of derivable) working[t] = null
    else for (const t of locked) if (derivable.has(t)) working[t] = null
    await evaluateRowRules(db, opts.collection, working, opts.parentContext, rules, undefined, {
      cache,
      locks: locked
    })
    const patch: Record<string, unknown> = {}
    const before: Record<string, unknown> = {}
    for (const t of targets) {
      const was = row[t]
      const now = working[t]
      if (String(now ?? '') === String(was ?? '')) continue
      if (opts.mode === 'empty-only' && !isEmpty(was) && !locked.has(t)) continue
      if (opts.mode === 'all' && isEmpty(now) && !isEmpty(was)) continue
      patch[t] = now ?? null
      before[t] = was ?? null
      plan.fields[t] = (plan.fields[t] ?? 0) + 1
    }
    if (Object.keys(patch).length) {
      plan.changes.push({
        id: String(row.id),
        patch,
        before,
        locked: [...locked].filter((t) => t in patch)
      })
    }
  }
  return plan
}

/** #817 — a grid's per-line field rules: the child collection's `required`
 *  flags and `validation_rules`, gated on what the grid actually shows (its
 *  child table layout, when it has one) and narrowed by its `row_filter`. */
export interface GridFieldCheck {
  field: string
  label: string
  required: boolean
  rules: Array<Record<string, unknown>>
}

export interface GridFieldConfig {
  aliasField: string
  label: string | null
  layoutId: number
  parentCollection: string
  childCollection: string
  fkField: string
  /** The grid's own `row_filter` — only the lines it shows are judged. */
  rowFilter: Record<string, unknown> | null
  fields: GridFieldCheck[]
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Inline-table grids on the parent's ACTIVE grouped layout whose lines carry
 *  a required flag or a validation rule on a column the grid shows. */
export async function gridFieldConfigsFor(parentCollection: string): Promise<GridFieldConfig[]> {
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection: parentCollection, layout_type: 'grouped', is_active: true })
    .first('id')) as { id: number } | undefined
  if (!layout) return []
  const [assignments, parentFields, rels] = await Promise.all([
    db('nivaro_layout_field_assignments')
      .where('layout_id', layout.id)
      .where('is_visible', true)
      .select('field', 'label_override', 'overrides') as Promise<
      Array<{ field: string; label_override: string | null; overrides: string | null }>
    >,
    db('nivaro_fields')
      .where('collection', parentCollection)
      .select('field', 'interface', 'options') as Promise<
      Array<{ field: string; interface: string | null; options: unknown }>
    >,
    db('nivaro_relations')
      .where('one_collection', parentCollection)
      .whereNull('junction_field')
      .select('one_field', 'many_collection', 'many_field') as Promise<
      Array<{ one_field: string | null; many_collection: string; many_field: string }>
    >
  ])
  const fieldRow = new Map(parentFields.map((f) => [f.field, f]))
  const out: GridFieldConfig[] = []
  for (const a of assignments) {
    const overrides = parseJson<{
      label?: string
      interface?: string
      options?: Record<string, unknown>
    }>(a.overrides)
    const base = fieldRow.get(a.field)
    const baseOpts = parseJson<Record<string, unknown>>(base?.options) ?? {}
    const iface = overrides?.interface ?? base?.interface
    if (iface !== 'inline-table') continue
    const opts = { ...baseOpts, ...(overrides?.options ?? {}) }
    // A catalog picker is not a line grid.
    if (opts.catalog_mode) continue
    const rel = rels.find((r) => r.one_field === a.field || r.many_collection === a.field)
    if (!rel || !IDENT_RE.test(rel.many_collection) || !IDENT_RE.test(rel.many_field)) continue
    const child = rel.many_collection
    const physical = new Set(
      (
        (await db('information_schema.columns')
          .where('table_name', child)
          .pluck('column_name')) as string[]
      ).map((c) => c.toLowerCase())
    )
    const childFields = (await db('nivaro_fields')
      .where('collection', child)
      .select('field', 'label', 'required', 'hidden', 'validation_rules', 'readonly')) as Array<{
      field: string
      label: string | null
      required: unknown
      hidden: unknown
      readonly: unknown
      validation_rules: unknown
    }>
    // What the grid shows: its child table layout's visible assignments (with
    // their own required overrides), else every non-hidden field.
    const tableLayoutId = Number(opts.layout_id) || null
    const shown = new Map<string, { required?: boolean; label?: string }>()
    if (tableLayoutId) {
      const tl = (await db('nivaro_layout_field_assignments')
        .where('layout_id', tableLayoutId)
        .where('is_visible', true)
        .select('field', 'label_override', 'overrides')) as Array<{
        field: string
        label_override: string | null
        overrides: string | null
      }>
      for (const t of tl) {
        const o = parseJson<{ required?: boolean; label?: string; readonly?: boolean }>(t.overrides)
        if (o?.readonly) continue
        shown.set(t.field, {
          required: o?.required,
          label: o?.label || t.label_override || undefined
        })
      }
    } else {
      for (const f of childFields) {
        if (!(f.hidden === true || f.hidden === 1)) shown.set(f.field, {})
      }
    }
    const fields: GridFieldCheck[] = []
    for (const f of childFields) {
      if (f.field === 'id' || f.field === rel.many_field) continue
      if (!IDENT_RE.test(f.field) || !physical.has(f.field.toLowerCase())) continue
      if (f.readonly === true || f.readonly === 1) continue
      const s = shown.get(f.field)
      if (!s) continue
      const rules = (parseJson<Array<Record<string, unknown>>>(f.validation_rules) ?? []).filter(
        // Calendar-relative rules judge the day a line is typed, not a saved
        // line forever after.
        (r) => r && typeof r === 'object' && !String(r.type ?? '').includes('days_from_today')
      )
      const required = s.required ?? (f.required === true || f.required === 1)
      if (!required && rules.length === 0) continue
      fields.push({
        field: f.field,
        label:
          s.label || f.label || f.field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        required,
        rules
      })
    }
    if (fields.length === 0) continue
    const rf = opts.row_filter
    // A row_filter that reads the open record cannot be judged here.
    if (rf && JSON.stringify(rf).includes('$parent.')) continue
    let rowFilter: Record<string, unknown> | null = null
    if (rf && typeof rf === 'object' && !Array.isArray(rf)) {
      rowFilter = {}
      for (const [k, v] of Object.entries(rf as Record<string, unknown>)) {
        rowFilter[k] = v !== null && typeof v === 'object' ? v : { _eq: v }
      }
    }
    out.push({
      aliasField: a.field,
      label: overrides?.label || a.label_override || null,
      layoutId: layout.id,
      parentCollection,
      childCollection: child,
      fkField: rel.many_field,
      rowFilter,
      fields
    })
  }
  return out
}
