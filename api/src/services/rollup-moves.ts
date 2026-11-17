import {
  getAllRollupContributors,
  getRollupContributors,
  matchesParentFilter,
  type RollupSource
} from './rollups.js'

/**
 * What one child-row write did to the stored totals on its parent (audit: "who changed the
 * requisition amount?"). A workflow's Requisition Amount is a rollup of its lines, so the
 * person who moved it is whoever wrote the line: the parent's history names the line write
 * and, beside it, how much each total moved because of it.
 *
 * Only plain sum / count sources are worked out (a row's contribution is its own value);
 * formula, average, min/max and recursive sources depend on the other rows and are left out
 * rather than guessed.
 */
export interface RollupMove {
  /** The rollup field on the parent. */
  field: string
  /** How much this write moved it (after − before). */
  delta: number
  /** The child column whose change moved it (the summed column); absent for a count. */
  source_field?: string
}

export interface ParentRollupSource {
  rollupField: string
  source: RollupSource
}

/** The stored rollups ON `parent` that `child` rows feed, one entry per source. */
export async function rollupSourcesFrom(
  parent: string,
  child: string
): Promise<ParentRollupSource[]> {
  const out: ParentRollupSource[] = []
  const seen = new Set<string>()
  for (const e of await getRollupContributors(child)) {
    if (e.parentCollection !== parent) continue
    for (const s of e.sources) {
      if (s.related_collection !== child || s.fk_field !== e.parentFk) continue
      const key = `${e.rollupField}|${s.fk_field}|${s.value_field}|${s.aggregate}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ rollupField: e.rollupField, source: s })
    }
  }
  return out
}

function contribution(row: Record<string, unknown> | null, s: RollupSource): number | null {
  if (!row) return 0
  if (s.filter && !matchesParentFilter(row, s.filter)) return 0
  if (s.aggregate === 'count') return 1
  const v = row[s.value_field]
  if (v == null || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * How a child row going from `before` to `after` (null = did not exist) moved each total.
 * Moves of zero are left out. Pure; exported for tests.
 */
export function rollupMoves(
  sources: ParentRollupSource[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): RollupMove[] {
  const byField = new Map<string, number>()
  const sourceOf = new Map<string, string>()
  for (const { rollupField, source } of sources) {
    if (source.recursive || source.value_formula) continue
    if (source.aggregate !== 'sum' && source.aggregate !== 'count') continue
    const a = contribution(before, source)
    const b = contribution(after, source)
    if (a == null || b == null) continue
    byField.set(rollupField, (byField.get(rollupField) ?? 0) + (b - a))
    if (source.aggregate === 'sum' && b !== a) sourceOf.set(rollupField, source.value_field)
  }
  const out: RollupMove[] = []
  for (const [field, delta] of byField) {
    const rounded = Math.round(delta * 10_000) / 10_000
    if (rounded === 0) continue
    const src = sourceOf.get(field)
    out.push(src ? { field, delta: rounded, source_field: src } : { field, delta: rounded })
  }
  return out
}

/** The child collections (and their link field) whose rows feed a stored rollup on `parent`. */
export async function rollupChildrenOf(
  parent: string
): Promise<Array<{ child: string; fk: string }>> {
  const out: Array<{ child: string; fk: string }> = []
  const seen = new Set<string>()
  for (const [child, entries] of await getAllRollupContributors()) {
    for (const e of entries) {
      if (e.parentCollection !== parent) continue
      const key = `${child}|${e.parentFk}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ child, fk: e.parentFk })
    }
  }
  return out
}
