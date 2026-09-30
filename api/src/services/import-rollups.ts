import { db } from '../db/index.js'
import {
  computeRollupTotalBatch,
  getRollupContributors,
  matchesParentFilter,
  type RollupContributorEntry
} from './rollups.js'

/**
 * #719 — a procedure writes raw rows, so no hook recalculates the stored
 * rollups those rows feed. An import definition names the collections its
 * procedure writes (`recalc_rollups`); after the run every stored rollup fed
 * by them is recomputed over its whole parent table, a chunk at a time:
 * one batched aggregate per source per 1,500 parents, then one UPDATE per 400
 * changed parents. Only values that differ are written. Same semantics as the
 * per-record recalc (computeRollupTotalBatch, parent_filter honoured).
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CHUNK = 1500
const WRITE_CHUNK = 400
const MAX_DEPTH = 3

export interface RollupRecalcLine {
  collection: string
  field: string
  checked: number
  changed: number
  error?: string
}

export function parseRecalcRollups(raw: unknown): string[] {
  let v: unknown = raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return []
    try {
      v = JSON.parse(t)
    } catch {
      v = t.split(',')
    }
  }
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const c = String(x ?? '').trim()
    if (IDENT.test(c) && !/^nivaro_/i.test(c) && !out.includes(c)) out.push(c)
  }
  return out
}

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v)

async function recalcOneField(
  entry: RollupContributorEntry,
  dryRun: boolean
): Promise<RollupRecalcLine> {
  const { parentCollection: parent, rollupField: field } = entry
  const line: RollupRecalcLine = { collection: parent, field, checked: 0, changed: 0 }
  if (!IDENT.test(parent) || !IDENT.test(field)) return { ...line, error: 'unsafe name' }
  const filterCols = Object.keys(entry.parentFilter ?? {}).filter((c) => IDENT.test(c))

  // Parents that have at least one contributor row, plus parents that hold a
  // value now (their last contributor may be gone — they must go back to null).
  const q = db(parent)
    .select('id', field, ...filterCols)
    .where((w) => {
      w.whereNotNull(field)
      for (const s of entry.sources) {
        if (!IDENT.test(s.related_collection) || !IDENT.test(s.fk_field)) continue
        w.orWhereIn('id', db(s.related_collection).whereNotNull(s.fk_field).distinct(s.fk_field))
      }
    })
  const rows = (await q) as Array<Record<string, unknown>>
  const eligible = rows.filter((r) => matchesParentFilter(r, entry.parentFilter))
  line.checked = eligible.length

  const changes: Array<{ id: unknown; value: number | null }> = []
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const slice = eligible.slice(i, i + CHUNK)
    const totals = await computeRollupTotalBatch(
      { sources: entry.sources },
      slice.map((r) => r.id),
      parent
    )
    for (const r of slice) {
      const next = totals.get(String(r.id)) ?? null
      const cur = numOrNull(r[field])
      const same =
        (next == null && cur == null) ||
        (next != null && cur != null && Math.abs(next - cur) < 0.00005)
      if (!same) changes.push({ id: r.id, value: next })
    }
  }

  for (let i = 0; !dryRun && i < changes.length; i += WRITE_CHUNK) {
    const part = changes.slice(i, i + WRITE_CHUNK)
    const values = part.map(() => '(?, CAST(? AS DECIMAL(38, 8)))').join(', ')
    const bindings = part.flatMap((c) => [String(c.id), c.value])
    await db.raw(
      `UPDATE p SET p.[${field}] = v.val FROM [${parent}] p JOIN (VALUES ${values}) v(id, val) ON p.id = v.id`,
      bindings
    )
  }
  line.changed = changes.length
  return line
}

/** Recompute every stored rollup fed by `collections` (and, when a parent
 *  changed, the rollups fed by that parent in turn). Never throws: a failed
 *  field is reported on its line. */
export async function recalcRollupsFedBy(
  collections: string[],
  depth = 0,
  seen = new Set<string>(),
  dryRun = false
): Promise<RollupRecalcLine[]> {
  const out: RollupRecalcLine[] = []
  const entries = new Map<string, RollupContributorEntry>()
  for (const c of collections) {
    for (const e of await getRollupContributors(c)) {
      const key = `${e.parentCollection}.${e.rollupField}`
      if (!seen.has(key) && !entries.has(key)) entries.set(key, e)
    }
  }
  const changedParents = new Set<string>()
  for (const [key, entry] of entries) {
    seen.add(key)
    try {
      const line = await recalcOneField(entry, dryRun)
      out.push(line)
      if (line.changed > 0) changedParents.add(entry.parentCollection)
    } catch (err) {
      out.push({
        collection: entry.parentCollection,
        field: entry.rollupField,
        checked: 0,
        changed: 0,
        error: String((err as Error)?.message ?? err).slice(0, 300)
      })
    }
  }
  // A dry run writes nothing, so nothing downstream can move.
  if (!dryRun && changedParents.size > 0 && depth < MAX_DEPTH) {
    out.push(...(await recalcRollupsFedBy([...changedParents], depth + 1, seen)))
  }
  return out
}

export function describeRollupRecalc(lines: RollupRecalcLine[]): string {
  if (lines.length === 0) return 'Rollups: no stored rollups are fed by the named collections.'
  const parts = lines.map((l) =>
    l.error
      ? `${l.collection}.${l.field} failed (${l.error})`
      : `${l.collection}.${l.field} ${l.changed.toLocaleString()} of ${l.checked.toLocaleString()} changed`
  )
  return `Rollups recalculated: ${parts.join(' · ')}`
}
