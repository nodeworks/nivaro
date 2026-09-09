import { db } from '../db/index.js'
import { evaluateRowRules, type RowRule, RowRuleLookupCache } from './field-rules.js'

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
  // NON-seed rule derives are blanked for re-derivation — a seed_only target
  // (default category / CIFA) is an input the rules fill when empty, never
  // one they own.
  const targets = new Set(rules.filter((r) => r.target_type !== 'lock').map((r) => r.target_field))
  const derivable = new Set(
    rules.filter((r) => r.target_type !== 'lock' && !r.seed_only).map((r) => r.target_field)
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
