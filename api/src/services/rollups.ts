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
  aggregate: 'sum' | 'count' | 'avg' | 'min' | 'max'
  value_field: string // column to aggregate (ignored for count)
  recursive?: boolean // if true: aggregate all descendants in same-collection tree
}

export interface NormalizedRollup {
  sources: RollupSource[]
}

const ROLLUP_AGGREGATES = new Set(['sum', 'count', 'avg', 'min', 'max'])

function isValidRollupSource(v: unknown): v is RollupSource {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  if (typeof s.related_collection !== 'string' || !s.related_collection) return false
  if (typeof s.fk_field !== 'string' || !s.fk_field) return false
  if (typeof s.aggregate !== 'string' || !ROLLUP_AGGREGATES.has(s.aggregate)) return false
  if (typeof s.value_field !== 'string') return false
  if (s.aggregate !== 'count' && !s.value_field) return false
  if (s.recursive !== undefined && typeof s.recursive !== 'boolean') return false
  return true
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

  return { sources: rawSources as RollupSource[] }
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
  if (cfg.aggregate !== 'count' && !cfg.value_field) return null
  if (id == null) return null

  try {
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
        .count('* as v')
        .first()) as { v: number } | undefined
      return Number(r?.v ?? 0)
    }

    const r = (await db(cfg.related_collection)
      .where(cfg.fk_field, id as Knex.Value)
      [cfg.aggregate](`${cfg.value_field} as v`)
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
          sources: cfg.sources
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
export async function recalcRollupsForParent(
  entry: RollupContributorEntry,
  parentId: unknown
): Promise<void> {
  if (parentId == null) return
  try {
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
  } catch (err) {
    console.error(
      { err, parentCollection: entry.parentCollection, rollupField: entry.rollupField, parentId },
      'Rollup recalc failed'
    )
    // swallow — recalc must never break the write that triggered it
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
