import type { Knex } from 'knex'
import { db } from '../db/index.js'

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

/**
 * Rollup computed field config — stored as JSON in `computed_formula` when
 * `computed_type === 'rollup'`. Aggregates related items in another collection.
 * A single field may combine multiple sources; each source contributes its own
 * aggregate and the results are summed (count contributes its count).
 */
export interface RollupSource {
  related_collection: string // table to aggregate from
  fk_field: string // column on related_collection pointing to this item's id
  aggregate: 'sum' | 'count' | 'avg' | 'min' | 'max' | 'median' | 'distinct_count' | 'weighted_avg'
  /** weighted_avg (#403): sum(value*weight)/sum(weight). */
  weight_field?: string
  value_field: string // column to aggregate (ignored for count)
  recursive?: boolean // if true: aggregate all descendants in same-collection tree
  /** Per-row arithmetic instead of a plain column: `{{col}}` and one-hop
   *  `{{m2o_fk.col}}` refs, +-*\/() only. Rows are fetched and reduced in JS
   *  (allocation-aware totals, price*qty, etc.). Not combinable with recursive. */
  value_formula?: string
  /** Optional row filter: {col: literal | {_eq/_neq/_gt/_gte/_lt/_lte/_null/_nnull/_in}}.
   *  `_neq` is NULL-SAFE (col != v OR col IS NULL — MSSQL would otherwise drop
   *  null rows, the is_osp trap). Ignored for recursive rollups. */
  filter?: Record<string, unknown>
}

export interface NormalizedRollup {
  sources: RollupSource[]
  /** Optional PARENT-row condition (same operator vocabulary as a source
   *  filter). A parent that does not match is left alone by every compute
   *  path — recalc, backfill, virtual read, the client's live figure — so the
   *  column holds a plain, hand-entered value for those rows. The CAR case:
   *  workflows.requisition_amount is a rollup over lines for purchase order requests but a simple
   *  decimal for CARs (workflow_type 2), which have no lines. */
  parent_filter?: Record<string, unknown>
}

/** JS twin of applyRollupFilter for a row already in hand. `_neq` is
 *  null-safe here too; a literal value means `_eq`. */
export function matchesParentFilter(
  row: Record<string, unknown> | null | undefined,
  filter: Record<string, unknown> | undefined
): boolean {
  if (!filter || typeof filter !== 'object') return true
  if (!row) return false
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? Number.NaN : Number(v))
  const same = (a: unknown, b: unknown) =>
    a === b ||
    (a != null && b != null && String(a) === String(b)) ||
    (typeof b === 'boolean' && num(a) === (b ? 1 : 0))
  for (const [col, spec] of Object.entries(filter)) {
    if (!IDENT_RE.test(col)) continue
    const val = row[col]
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec as Record<string, unknown>)) {
        switch (op) {
          case '_eq':
            if (!same(val, v)) return false
            break
          case '_neq':
            if (val != null && same(val, v)) return false
            break
          case '_gt':
            if (!(num(val) > num(v))) return false
            break
          case '_gte':
            if (!(num(val) >= num(v))) return false
            break
          case '_lt':
            if (!(num(val) < num(v))) return false
            break
          case '_lte':
            if (!(num(val) <= num(v))) return false
            break
          case '_null':
            if (val != null) return false
            break
          case '_nnull':
            if (val == null) return false
            break
          case '_in':
            if (!Array.isArray(v) || !v.some((x) => same(val, x))) return false
            break
          default:
            break
        }
      }
    } else if (!same(val, spec)) return false
  }
  return true
}

const ROLLUP_AGGREGATES = new Set([
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'median',
  'distinct_count',
  'weighted_avg'
])

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Apply a RollupSource.filter to a query. Unknown ops and bad identifiers are
 *  skipped (filter is admin-authored config; a typo must not break the write
 *  path that triggers recalcs). */
function applyRollupFilter(
  q: Knex.QueryBuilder,
  filter: Record<string, unknown> | undefined
): void {
  if (!filter || typeof filter !== 'object') return
  for (const [col, spec] of Object.entries(filter)) {
    if (!IDENT_RE.test(col)) continue
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      for (const [op, v] of Object.entries(spec as Record<string, unknown>)) {
        switch (op) {
          case '_eq':
            q.where(col, v as Knex.Value)
            break
          case '_neq':
            // Null-safe: MSSQL `col != v` silently excludes NULL rows.
            q.where((b) => b.whereNot(col, v as Knex.Value).orWhereNull(col))
            break
          case '_gt':
            q.where(col, '>', v as Knex.Value)
            break
          case '_gte':
            q.where(col, '>=', v as Knex.Value)
            break
          case '_lt':
            q.where(col, '<', v as Knex.Value)
            break
          case '_lte':
            q.where(col, '<=', v as Knex.Value)
            break
          case '_null':
            q.whereNull(col)
            break
          case '_nnull':
            q.whereNotNull(col)
            break
          case '_in':
            if (Array.isArray(v)) q.whereIn(col, v as Knex.Value[])
            break
          default:
            break
        }
      }
    } else {
      q.where(col, spec as Knex.Value)
    }
  }
}

function isValidRollupSource(v: unknown): v is RollupSource {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  if (typeof s.related_collection !== 'string' || !s.related_collection) return false
  if (typeof s.fk_field !== 'string' || !s.fk_field) return false
  if (typeof s.aggregate !== 'string' || !ROLLUP_AGGREGATES.has(s.aggregate)) return false
  if (s.value_field !== undefined && typeof s.value_field !== 'string') return false
  if (s.value_formula !== undefined && typeof s.value_formula !== 'string') return false
  if (s.aggregate !== 'count' && !s.value_field && !s.value_formula) return false
  if (s.recursive !== undefined && typeof s.recursive !== 'boolean') return false
  if (s.recursive && s.value_formula) return false
  return true
}

// ─── value_formula evaluation ────────────────────────────────────────────────

const FORMULA_REF_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\}\}/g

function evalNumericFormula(template: string, values: Record<string, number>): number | null {
  const expr = template.replace(FORMULA_REF_RE, (_, ref: string) => String(values[ref] ?? 0))
  if (!/^[-+*/(). 0-9eE]+$/.test(expr)) return null
  try {
    // biome-ignore lint/security/noGlobalEval: input sanitized to arithmetic chars above
    const v = new Function(`"use strict"; return (${expr})`)() as unknown
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Formula-mode rollup: fetch the related rows (plus any one-hop M2O columns the
 * formula references, batch-resolved via nivaro_relations), evaluate the
 * arithmetic per row, then reduce by the configured aggregate.
 */
async function computeFormulaRollup(cfg: RollupSource, id: unknown): Promise<number | null> {
  const refs = [...cfg.value_formula!.matchAll(FORMULA_REF_RE)].map((m) => m[1])
  if (refs.length === 0) return null
  const direct = [...new Set(refs.filter((r) => !r.includes('.')))]
  const dotted = [...new Set(refs.filter((r) => r.includes('.')))]
  const hopFks = [...new Set(dotted.map((d) => d.split('.')[0]))]

  const rows = (await db(cfg.related_collection)
    .where(cfg.fk_field, id as Knex.Value)
    .modify((q) => applyRollupFilter(q, cfg.filter))
    .select(['id', ...direct, ...hopFks])) as Array<Record<string, unknown>>
  if (rows.length === 0) return cfg.aggregate === 'count' ? 0 : null

  // Batch-resolve one-hop M2O refs: hop fk → related table → needed columns
  const hopValues = new Map<string, Map<string, Record<string, unknown>>>()
  for (const fk of hopFks) {
    // No junction_field guard: an M2M junction's M2O legs legitimately carry
    // junction_field (the pairing marker) — one_collection is the real test.
    const rel = (await db('nivaro_relations')
      .where({ many_collection: cfg.related_collection, many_field: fk })
      .first()) as { one_collection: string | null } | undefined
    if (!rel?.one_collection) continue
    const cols = [
      ...new Set(dotted.filter((d) => d.startsWith(`${fk}.`)).map((d) => d.split('.')[1]))
    ]
    const ids = [...new Set(rows.map((r) => r[fk]).filter((v) => v != null))]
    if (ids.length === 0) continue
    const related = (await db(rel.one_collection)
      .whereIn('id', ids as Knex.Value[])
      .select(['id', ...cols])) as Array<Record<string, unknown>>
    hopValues.set(fk, new Map(related.map((r) => [String(r.id), r])))
  }

  const perRow: number[] = []
  for (const row of rows) {
    const values: Record<string, number> = {}
    for (const d of direct) values[d] = Number(row[d] ?? 0) || 0
    for (const path of dotted) {
      const [fk, col] = path.split('.')
      const hit = row[fk] != null ? hopValues.get(fk)?.get(String(row[fk])) : undefined
      values[path] = Number(hit?.[col] ?? 0) || 0
    }
    const v = evalNumericFormula(cfg.value_formula!, values)
    if (v != null) perRow.push(v)
  }
  if (perRow.length === 0) return cfg.aggregate === 'count' ? 0 : null

  switch (cfg.aggregate) {
    case 'count':
      return perRow.length
    case 'distinct_count':
      return new Set(perRow).size
    case 'avg':
      return perRow.reduce((a, b) => a + b, 0) / perRow.length
    case 'median': {
      const sorted = [...perRow].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }
    case 'min':
      return Math.min(...perRow)
    case 'max':
      return Math.max(...perRow)
    default:
      return perRow.reduce((a, b) => a + b, 0)
  }
}

/**
 * Normalize a stored rollup config into `{ sources: [...] }`.
 * Accepts either the legacy single-source object shape or `{ sources: [...] }`.
 * Returns null when the JSON is unparseable or any source is invalid.
 */
export function parseRollupFormula(raw: string | null): NormalizedRollup | null {
  const parsed = parseJson<Record<string, unknown>>(raw)
  if (!parsed || typeof parsed !== 'object') return null

  const rawSources = Array.isArray((parsed as { sources?: unknown }).sources)
    ? (parsed as { sources: unknown[] }).sources
    : [parsed]

  if (!rawSources.length) return null
  if (!rawSources.every(isValidRollupSource)) return null

  const pf = (parsed as { parent_filter?: unknown }).parent_filter
  const parent_filter =
    pf && typeof pf === 'object' && !Array.isArray(pf) && Object.keys(pf as object).length > 0
      ? (pf as Record<string, unknown>)
      : undefined
  return parent_filter
    ? { sources: rawSources as RollupSource[], parent_filter }
    : { sources: rawSources as RollupSource[] }
}

/**
 * Compute a single rollup value for one item id.
 * Non-recursive: simple aggregate over related_collection where fk_field = id.
 * Recursive (same-collection tree): aggregate over all descendants via CTE.
 * Returns null on any error or invalid config.
 */
async function computeRollupValue(
  cfg: RollupSource,
  id: unknown,
  hostCollection?: string
): Promise<number | null> {
  if (!cfg.related_collection || !cfg.fk_field || !ROLLUP_AGGREGATES.has(cfg.aggregate)) {
    return null
  }
  if (cfg.aggregate !== 'count' && !cfg.value_field && !cfg.value_formula) return null
  if (id == null) return null

  try {
    if (cfg.value_formula) return await computeFormulaRollup(cfg, id)

    // Recursive rollups only make sense over a same-collection tree — the CTE
    // self-joins related_collection on fk_field, which is defined as pointing at
    // the HOST collection's ids. A mismatched recursive config (only reachable via
    // hand-authored JSON) falls back to the flat aggregate, as it always has.
    if (cfg.recursive && hostCollection === cfg.related_collection) {
      // MSSQL recursive CTE — gather all descendant ids at any depth, then aggregate.
      // Identifiers are bound via ?? (escaped); the id value via ?.
      // MSSQL CTEs never use the RECURSIVE keyword; MAXRECURSION guards depth.
      const selectExpr =
        cfg.aggregate === 'count' ? 'COUNT(*)' : `${cfg.aggregate.toUpperCase()}(??)`

      const sql = `WITH descendants AS (
  SELECT id FROM ?? WHERE ?? = ?
  UNION ALL
  SELECT c.id FROM ?? c INNER JOIN descendants d ON c.?? = d.id
)
SELECT ${selectExpr} AS v FROM ?? WHERE id IN (SELECT id FROM descendants)
OPTION (MAXRECURSION 100)`

      // Binding order:
      //   ?? related_collection (anchor FROM)
      //   ?? fk_field           (anchor WHERE)
      //   ?  id
      //   ?? related_collection (recursive FROM)
      //   ?? fk_field           (recursive JOIN)
      //   [?? value_field — only when aggregate != count, inside selectExpr]
      //   ?? related_collection (final FROM)
      const binds: Knex.RawBinding[] =
        cfg.aggregate === 'count'
          ? [
              cfg.related_collection,
              cfg.fk_field,
              id as Knex.Value,
              cfg.related_collection,
              cfg.fk_field,
              cfg.related_collection
            ]
          : [
              cfg.related_collection,
              cfg.fk_field,
              id as Knex.Value,
              cfg.related_collection,
              cfg.fk_field,
              cfg.value_field,
              cfg.related_collection
            ]

      const raw = (await db.raw(sql, binds)) as
        | { recordset?: Array<{ v: number | null }> }
        | Array<{ v: number | null }>
      const recordset = Array.isArray(raw) ? raw : raw.recordset
      const v = recordset?.[0]?.v
      if (v != null) return Number(v)
      return cfg.aggregate === 'count' ? 0 : null
    }

    if (cfg.aggregate === 'count') {
      const r = (await db(cfg.related_collection)
        .where(cfg.fk_field, id as Knex.Value)
        .modify((q) => applyRollupFilter(q, cfg.filter))
        .count('* as v')
        .first()) as { v: number } | undefined
      return Number(r?.v ?? 0)
    }

    // Median / distinct-count / weighted-average (#402/#403): fetched + reduced
    // in JS — MSSQL's PERCENTILE_CONT needs OVER clauses knex can't compose here.
    if (
      cfg.aggregate === 'median' ||
      cfg.aggregate === 'distinct_count' ||
      cfg.aggregate === 'weighted_avg'
    ) {
      const cols = [cfg.value_field]
      if (cfg.aggregate === 'weighted_avg' && cfg.weight_field) cols.push(cfg.weight_field)
      const rows = (await db(cfg.related_collection)
        .where(cfg.fk_field, id as Knex.Value)
        .modify((q) => applyRollupFilter(q, cfg.filter))
        .limit(10_000)
        .select(cols)) as Array<Record<string, unknown>>
      const nums = rows.map((row) => Number(row[cfg.value_field])).filter((n) => Number.isFinite(n))
      if (cfg.aggregate === 'distinct_count') return new Set(nums).size
      if (nums.length === 0) return null
      if (cfg.aggregate === 'median') {
        const sorted = [...nums].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
      }
      // weighted_avg
      const wf = cfg.weight_field
      if (!wf) return nums.reduce((a, b) => a + b, 0) / nums.length
      let wSum = 0
      let vSum = 0
      for (const row of rows) {
        const v = Number(row[cfg.value_field])
        const w = Number(row[wf])
        if (!Number.isFinite(v) || !Number.isFinite(w)) continue
        vSum += v * w
        wSum += w
      }
      return wSum === 0 ? null : vSum / wSum
    }

    const r = (await db(cfg.related_collection)
      .where(cfg.fk_field, id as Knex.Value)
      .modify((q) => applyRollupFilter(q, cfg.filter))
      [cfg.aggregate as 'sum' | 'avg' | 'min' | 'max'](`${cfg.value_field} as v`)
      .first()) as { v: number | null } | undefined
    return r?.v != null ? Number(r.v) : null
  } catch {
    return null
  }
}

/**
 * Compute the combined value of a (possibly multi-source) rollup: each source's
 * aggregate via `computeRollupValue`, summed together. A source that returns
 * null contributes 0 to the sum; if every source returns null, the result is
 * null (distinguishing "no data" from "sums to zero").
 */
export async function computeRollupTotal(
  cfg: NormalizedRollup,
  id: unknown,
  hostCollection?: string
): Promise<number | null> {
  const values = await Promise.all(
    cfg.sources.map((source) => computeRollupValue(source, id, hostCollection))
  )
  if (values.every((v) => v == null)) return null
  return values.reduce((sum: number, v) => sum + (v ?? 0), 0)
}

// ─── Contributor map (stored-rollup recalc) ───────────────────────────────────

/**
 * One rollup field whose value must be recomputed when a row changes in
 * `sources[].related_collection`. `parentFk` is the column on the CONTRIBUTOR
 * (child) row that points back at the parent whose rollup field needs recalc.
 */
export interface RollupContributorEntry {
  parentCollection: string
  parentFk: string
  rollupField: string
  sources: RollupSource[] // full config — recalc recomputes ALL sources, not just the triggering one
  /** Parent rows not matching this are never written (see NormalizedRollup). */
  parentFilter?: Record<string, unknown>
}

interface RollupFieldRow {
  collection: string
  field: string
  computed_formula: string | null
  computed_store: boolean | number | null
}

// Per-process cache of childCollection → contributor entries. Built once from
// nivaro_fields; bustRollupContributorCache() clears it after config changes.
let contributorCache: Map<string, RollupContributorEntry[]> | null = null

async function buildContributorCache(): Promise<Map<string, RollupContributorEntry[]>> {
  const map = new Map<string, RollupContributorEntry[]>()
  try {
    const rows = (await db('nivaro_fields')
      .where({ computed_type: 'rollup' })
      .whereNotNull('computed_formula')
      .select('collection', 'field', 'computed_formula', 'computed_store')) as RollupFieldRow[]

    for (const row of rows) {
      const stored = row.computed_store === true || row.computed_store === 1
      if (!stored) continue

      const cfg = parseRollupFormula(row.computed_formula)
      if (!cfg) continue

      for (const source of cfg.sources) {
        const entry: RollupContributorEntry = {
          parentCollection: row.collection,
          parentFk: source.fk_field,
          rollupField: row.field,
          sources: cfg.sources,
          parentFilter: cfg.parent_filter
        }
        const list = map.get(source.related_collection)
        if (list) list.push(entry)
        else map.set(source.related_collection, [entry])
      }
    }
  } catch {
    // nivaro_fields columns may not exist yet before migration runs — non-fatal.
  }
  return map
}

/** Contributor entries for rollup fields affected by a write to `childCollection`. */
export async function getRollupContributors(
  childCollection: string
): Promise<RollupContributorEntry[]> {
  if (!contributorCache) {
    contributorCache = await buildContributorCache()
  }
  return contributorCache.get(childCollection) ?? []
}

/** Clears the cached contributor map; the next lookup rebuilds it from nivaro_fields. */
export function bustRollupContributorCache(): void {
  contributorCache = null
}

/**
 * Recompute one parent row's rollup column and write it via a raw update —
 * never createOne/updateOne, to avoid re-triggering hooks/rules/recalc.
 * Skips the write when the recomputed total matches the current value.
 * Never throws: a recalc failure must not break the write that triggered it.
 */
// A stored rollup can itself feed another stored rollup (workflow lines →
// workflows.requisition_amount → projects.pub_amount). The parent write here
// is RAW, so nothing downstream would ever notice it; cascade explicitly,
// bounded so a mis-configured cycle cannot run away.
const MAX_CASCADE_DEPTH = 3

export async function recalcRollupsForParent(
  entry: RollupContributorEntry,
  parentId: unknown,
  depth = 0
): Promise<void> {
  if (parentId == null) return
  try {
    if (entry.parentFilter) {
      const cols = Object.keys(entry.parentFilter).filter((c) => IDENT_RE.test(c))
      const parent = (await db(entry.parentCollection)
        .where({ id: parentId })
        .first(...(cols.length ? cols : ['id']))) as Record<string, unknown> | undefined
      if (!matchesParentFilter(parent, entry.parentFilter)) return
    }
    const total = await computeRollupTotal(
      { sources: entry.sources },
      parentId,
      entry.parentCollection
    )

    const current = (await db(entry.parentCollection)
      .where({ id: parentId })
      .select(entry.rollupField)
      .first()) as Record<string, unknown> | undefined
    const currentRaw = current?.[entry.rollupField]
    const currentNum = currentRaw == null ? null : Number(currentRaw)

    if (currentNum === total) return

    await db(entry.parentCollection)
      .where({ id: parentId })
      .update({ [entry.rollupField]: total })
    // Cascade: is this parent row itself a contributor to a stored rollup on
    // ITS parent? Only when one of those rollups reads the field we just wrote.
    if (depth < MAX_CASCADE_DEPTH) {
      const grand = (await getRollupContributors(entry.parentCollection)).filter((g) =>
        g.sources.some(
          (s) =>
            s.related_collection === entry.parentCollection &&
            (s.value_field === entry.rollupField ||
              (s.value_formula ?? '').includes(`{{${entry.rollupField}}}`))
        )
      )
      if (grand.length > 0) {
        const fks = [...new Set(grand.map((g) => g.parentFk))]
        const row = (await db(entry.parentCollection)
          .where({ id: parentId })
          .first(...fks)) as Record<string, unknown> | undefined
        for (const g of grand) {
          const gid = row?.[g.parentFk]
          if (gid != null) await recalcRollupsForParent(g, gid, depth + 1)
        }
      }
    }
  } catch (err) {
    console.error(
      { err, parentCollection: entry.parentCollection, rollupField: entry.rollupField, parentId },
      'Rollup recalc failed'
    )
    // swallow — recalc must never break the write that triggered it
    const { countSwallow } = await import('./swallow-counter.js')
    countSwallow('rollup-recalc', err)
  }
}

/**
 * Recalc every rollup affected by a write to `childCollection` touching `row`
 * (and `previousRow`, when its parentFk value differs, for the dual recalc on
 * an FK change — both the old and new parent get recomputed). No-op when the
 * collection has no rollup contributors.
 */
export async function recalcAffectedRollups(
  childCollection: string,
  row: Record<string, unknown> | null,
  previousRow?: Record<string, unknown> | null
): Promise<void> {
  try {
    const entries = await getRollupContributors(childCollection)
    if (!entries.length) return

    for (const entry of entries) {
      const ids = new Set<unknown>()
      const rowId = row?.[entry.parentFk]
      const prevId = previousRow?.[entry.parentFk]
      if (rowId != null) ids.add(rowId)
      if (prevId != null) ids.add(prevId)

      for (const id of ids) {
        await recalcRollupsForParent(entry, id)
      }
    }
  } catch (err) {
    console.error({ err, childCollection }, 'Rollup recalc failed for child collection')
    // swallow — recalc must never break the write that triggered it
    const { countSwallow } = await import('./swallow-counter.js')
    countSwallow('rollup-recalc-affected', err)
  }
}

/**
 * Bulk variant for import/bulk-write paths (Task 3): recalc rollups for an
 * explicit set of parent ids per child collection, rather than deriving ids
 * from a single row/previousRow pair.
 */
export async function recalcCollectionsParents(
  pairs: Array<{ childCollection: string; parentIds: unknown[] }>
): Promise<void> {
  for (const { childCollection, parentIds } of pairs) {
    if (!parentIds.length) continue
    const entries = await getRollupContributors(childCollection)
    for (const entry of entries) {
      for (const id of parentIds) {
        await recalcRollupsForParent(entry, id)
      }
    }
  }
}
