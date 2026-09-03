import { db } from '../db/index.js'
import { evaluateRowRules, type RowRule } from './field-rules.js'

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

/**
 * Layout row-rule autofill for child rows created straight through the API.
 *
 * The admin form runs a grid's `options.row_rules` on every row it stages —
 * that is how a workflow line picks up its Oracle category from the chosen
 * CIFA, its task from the project-type-filtered cifa_tasks/category_tasks
 * precedence chain, and its line_type from the parent's workflow_type. But
 * those rules lived only in the browser's request loop: a line created via
 * `POST /items/workflow_line_items` (SDK, integration, script) arrived with
 * none of that autofill, so API-created data was silently poorer than
 * UI-created data.
 *
 * This runs the SAME evaluator (services/field-rules.ts) inside createOne.
 * Semantics chosen deliberately:
 *
 *   - The rules come from the parent collection's ACTIVE grouped layout — the
 *     one ItemEdit itself would use. A slug-only or role-conditional layout's
 *     rules are a per-audience view concern and do not apply to API writes.
 *   - CALLER-PROVIDED VALUES WIN. In the UI, rules re-fire as the user edits,
 *     so "rule overwrites field" has an ordering. An API payload arrives all
 *     at once — a caller who explicitly sent `task: 7` meant it, and a rule
 *     silently replacing it would be worse than the old missing-autofill.
 *     Rules therefore only ever fill fields ABSENT from the original payload.
 *   - CREATE ONLY. A PATCH is an explicit statement about specific fields;
 *     re-running autofill on update would let a rule fight the caller.
 *   - Never throws. Autofill failing must not fail the create — the row just
 *     lands without defaults, exactly as every API create did before this.
 */

interface GridRuleConfig {
  /** Child collection the grid renders. */
  childCollection: string
  /** FK column on the child pointing at the parent. */
  fkField: string
  parentCollection: string
  rowRules: RowRule[]
  parentContextFields: string[]
}

// Layout config changes rarely; a stampede of line creates (imports) must not
// re-read layouts per row. Same 60s posture as the other metadata caches.
let cache: { at: number; byChild: Map<string, GridRuleConfig[]> } | null = null
const TTL = 60_000

export function clearRowRuleCache(): void {
  cache = null
}

async function buildCache(): Promise<Map<string, GridRuleConfig[]>> {
  const byChild = new Map<string, GridRuleConfig[]>()

  // Every active grouped layout's assignments that carry row_rules. The LIKE
  // narrows the scan to the handful of rows that matter before any JSON work.
  const rows = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .where('l.is_active', true)
    .where('l.layout_type', 'grouped')
    .whereRaw("a.overrides LIKE '%row_rules%'")
    .select('l.collection as parent_collection', 'a.field', 'a.overrides')) as Array<{
    parent_collection: string
    field: string
    overrides: string | null
  }>
  if (rows.length === 0) return byChild

  const parents = [...new Set(rows.map((r) => r.parent_collection))]
  const rels = (await db('nivaro_relations')
    .whereIn('one_collection', parents)
    .whereNull('junction_field')
    .select('one_collection', 'one_field', 'many_collection', 'many_field')) as Array<{
    one_collection: string
    one_field: string | null
    many_collection: string
    many_field: string
  }>

  for (const row of rows) {
    const overrides = parseJson(row.overrides) as { options?: Record<string, unknown> } | null
    const opts = overrides?.options
    const rowRules = Array.isArray(opts?.row_rules) ? (opts.row_rules as RowRule[]) : []
    if (rowRules.length === 0) continue

    // The assignment's field is the O2M alias (one_field) or, for a second
    // grid on the same relation, the child table's own name — the same two
    // resolution forms FieldRenderer uses.
    const rel = rels.find(
      (r) =>
        r.one_collection === row.parent_collection &&
        (r.one_field === row.field || r.many_collection === row.field)
    )
    if (!rel) continue

    const cfg: GridRuleConfig = {
      childCollection: rel.many_collection,
      fkField: rel.many_field,
      parentCollection: row.parent_collection,
      rowRules,
      parentContextFields: Array.isArray(opts?.parent_context_fields)
        ? (opts.parent_context_fields as string[])
        : []
    }
    const list = byChild.get(rel.many_collection) ?? []
    list.push(cfg)
    byChild.set(rel.many_collection, list)
  }

  return byChild
}

async function getConfigs(childCollection: string): Promise<GridRuleConfig[]> {
  if (!cache || Date.now() - cache.at > TTL) {
    cache = { at: Date.now(), byChild: await buildCache() }
  }
  return cache.byChild.get(childCollection) ?? []
}

/**
 * Fill layout-rule defaults into a child-row create payload. Mutates payload.
 * `callerFields` is the set of keys the ORIGINAL request body carried — those
 * are never overwritten, whatever the rules say.
 */
/**
 * Enforce 'lock' row rules on a write. A locked field is dropped from the
 * caller's payload (and from `callerFields`, so the create-time autofill can
 * fill it) — the same silent-ignore posture as field lock_condition. On
 * update the lock is judged against the merged row (existing + payload) so a
 * category change in the same PATCH locks price immediately. Never throws.
 */
export async function applyRowLocksOnWrite(
  collection: string,
  payload: Record<string, unknown>,
  callerFields: Set<string>,
  existing: Record<string, unknown> | null
): Promise<string[]> {
  if (collection.startsWith('nivaro_')) return []
  const dropped: string[] = []
  try {
    const configs = await getConfigs(collection)
    if (configs.length === 0) return dropped
    for (const cfg of configs) {
      if (!cfg.rowRules.some((r) => r.target_type === 'lock')) continue
      const merged = { ...(existing ?? {}), ...payload }
      const fkValue = merged[cfg.fkField]
      if (fkValue == null || fkValue === '') continue
      const wanted = new Set(cfg.parentContextFields)
      for (const rule of cfg.rowRules) {
        const tf = rule.trigger_field
        if (typeof tf === 'string' && tf.startsWith('$parent.')) wanted.add(tf.slice(8))
      }
      const parentContext: Record<string, unknown> = {}
      if (wanted.size > 0) {
        const parent = (await db(cfg.parentCollection)
          .where({ id: String(fkValue) })
          .first()) as Record<string, unknown> | undefined
        if (parent) for (const f of wanted) parentContext[f] = parent[f] ?? null
      }
      const locks = new Set<string>()
      await evaluateRowRules(db, collection, { ...merged }, parentContext, cfg.rowRules, undefined, {
        locks,
        locksOnly: true
      })
      for (const field of locks) {
        if (!(field in payload)) continue
        // Re-sending the stored value is harmless; only a CHANGE is refused.
        if (existing && String(payload[field] ?? '') === String(existing[field] ?? '')) continue
        delete payload[field]
        callerFields.delete(field)
        dropped.push(field)
      }
    }
  } catch (err) {
    console.warn(`row-rules lock check skipped for ${collection}:`, err)
  }
  return dropped
}

export async function applyRowRulesOnCreate(
  collection: string,
  payload: Record<string, unknown>,
  callerFields: Set<string>
): Promise<void> {
  if (collection.startsWith('nivaro_')) return
  try {
    const configs = await getConfigs(collection)
    if (configs.length === 0) return

    for (const cfg of configs) {
      const fkValue = payload[cfg.fkField]
      if (fkValue == null || fkValue === '') continue

      // Parent context: the fields the layout declares plus any $parent.*
      // fields the rules themselves reference — read off the real parent row.
      const wanted = new Set(cfg.parentContextFields)
      for (const rule of cfg.rowRules) {
        const tf = rule.trigger_field
        if (typeof tf === 'string' && tf.startsWith('$parent.')) wanted.add(tf.slice(8))
      }
      let parentContext: Record<string, unknown> = {}
      if (wanted.size > 0) {
        const parent = (await db(cfg.parentCollection)
          .where({ id: String(fkValue) })
          .first()) as Record<string, unknown> | undefined
        if (!parent) continue
        parentContext = {}
        for (const f of wanted) parentContext[f] = parent[f] ?? null
      }

      const working = { ...payload }
      await evaluateRowRules(db, collection, working, parentContext, cfg.rowRules)

      for (const [key, value] of Object.entries(working)) {
        if (callerFields.has(key)) continue // explicit caller value always wins
        if (value !== payload[key]) payload[key] = value
      }
    }
  } catch (err) {
    // Autofill is a favor, not a contract — the create proceeds without it.
    console.warn(`row-rules autofill skipped for ${collection}:`, err)
  }
}
