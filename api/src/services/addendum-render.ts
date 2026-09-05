import { Parser } from 'expr-eval'
import { db } from '../db/index.js'
import { loadAddendums } from './pipeline-subject.js'
import { matchesParentFilter, parseRollupFormula } from './rollups.js'

/**
 * What a document rendered FOR an addendum should show: the parent record with
 * the addendum's proposed scalars overlaid, its proposed child rows in place of
 * the stored ones, and every rollup those rows feed recomputed from them — a PO
 * addendum's Requisition Amount is the sum of the PROPOSED lines, which no
 * stored column holds until the addendum is approved.
 */
export interface AddendumRenderOverlay {
  item: Record<string, unknown>
  /** alias field → proposed child rows (write-computed columns applied) */
  childRowsOverride: Record<string, Record<string, unknown>[]>
  title: string | null
}

const parser = new Parser({
  operators: { logical: true, comparison: true, in: true, concatenate: true }
})

function evalWrite(formula: string, row: Record<string, unknown>): unknown {
  try {
    const v = parser.evaluate(formula, { item: row } as never)
    return typeof v === 'number' && !Number.isFinite(v) ? null : v
  } catch {
    return null
  }
}

type FilterSpec = Record<string, unknown>
function rowMatches(row: Record<string, unknown>, filter: FilterSpec | undefined): boolean {
  if (!filter) return true
  for (const [col, spec] of Object.entries(filter)) {
    const v = row[col]
    if (spec === null || typeof spec !== 'object') {
      if (String(v ?? '') !== String(spec ?? '')) return false
      continue
    }
    for (const [op, want] of Object.entries(spec as Record<string, unknown>)) {
      const n = Number(v)
      const w = Number(want)
      switch (op) {
        case '_eq':
          if (String(v ?? '') !== String(want ?? '')) return false
          break
        case '_neq':
          // Null-safe, matching the SQL source filter (`col != v OR col IS NULL`).
          if (v != null && String(v) === String(want)) return false
          break
        case '_gt':
          if (!(n > w)) return false
          break
        case '_gte':
          if (!(n >= w)) return false
          break
        case '_lt':
          if (!(n < w)) return false
          break
        case '_lte':
          if (!(n <= w)) return false
          break
        case '_null':
          if ((v == null) !== !!want) return false
          break
        case '_nnull':
          if ((v != null) !== !!want) return false
          break
        case '_in':
          if (!(Array.isArray(want) ? want : [want]).some((x) => String(x) === String(v ?? '')))
            return false
          break
        default:
          break
      }
    }
  }
  return true
}

export async function buildAddendumRenderOverlay(
  collection: string,
  item: Record<string, unknown>,
  addendumId: string
): Promise<AddendumRenderOverlay | null> {
  const info = (await loadAddendums([addendumId])).get(addendumId)
  if (!info || info.parentCollection !== collection) return null
  if (String(info.parentId) !== String(item.id)) return null
  const row = (await db('nivaro_addendums').where({ id: addendumId }).first('data', 'title')) as
    | { data: string | null; title: string | null }
    | undefined
  let data: Record<string, unknown> = {}
  try {
    data = row?.data ? (JSON.parse(row.data) as Record<string, unknown>) : {}
  } catch {
    data = {}
  }

  const merged: Record<string, unknown> = { ...item }
  const childRowsOverride: Record<string, Record<string, unknown>[]> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('__')) continue
    if (Array.isArray(value)) childRowsOverride[key] = value as Record<string, unknown>[]
    else if (value !== undefined) merged[key] = value
  }

  // Resolve each proposed alias to its child collection so write-computed
  // columns (amount = price × quantity) can be applied to the proposed rows.
  const aliases = Object.keys(childRowsOverride)
  if (aliases.length === 0) return { item: merged, childRowsOverride, title: info.title }
  const rels = (await db('nivaro_relations')
    .where({ one_collection: collection })
    .whereNull('junction_field')
    .select('many_collection', 'many_field', 'one_field')) as Array<{
    many_collection: string
    many_field: string
    one_field: string | null
  }>
  const relForAlias = (alias: string) =>
    rels.find((r) => (r.one_field ?? r.many_collection) === alias)
  const childCollections = [
    ...new Set(aliases.map((a) => relForAlias(a)?.many_collection).filter(Boolean) as string[])
  ]
  const writeFields = childCollections.length
    ? ((await db('nivaro_fields')
        .whereIn('collection', childCollections)
        .where({ computed_type: 'write' })
        .whereNotNull('computed_formula')
        .select('collection', 'field', 'computed_formula')) as Array<{
        collection: string
        field: string
        computed_formula: string
      }>)
    : []
  for (const alias of aliases) {
    const rel = relForAlias(alias)
    if (!rel) continue
    const writes = writeFields.filter((w) => w.collection === rel.many_collection)
    if (writes.length === 0) continue
    childRowsOverride[alias] = childRowsOverride[alias].map((r) => {
      const next = { ...r }
      for (const w of writes) {
        const v = evalWrite(w.computed_formula, next)
        if (v !== null && v !== undefined) next[w.field] = v
      }
      return next
    })
  }

  // Rollups over the proposed rows. A rollup whose every source is proposed
  // recomputes; one with an unproposed source keeps the stored figure — a
  // half-known total is worse than a stale one.
  const rollups = (await db('nivaro_fields')
    .where({ collection, computed_type: 'rollup' })
    .whereNotNull('computed_formula')
    .select('field', 'computed_formula')) as Array<{ field: string; computed_formula: string }>
  for (const f of rollups) {
    const cfg = parseRollupFormula(f.computed_formula)
    if (!cfg || cfg.sources.length === 0) continue
    if (cfg.sources.some((s) => s.recursive || s.value_formula)) continue
    if (!matchesParentFilter(merged, cfg.parent_filter)) continue
    let total: number | null = null
    let complete = true
    for (const src of cfg.sources) {
      const rel = rels.find(
        (r) => r.many_collection === src.related_collection && r.many_field === src.fk_field
      )
      const alias = rel ? (rel.one_field ?? rel.many_collection) : null
      const rows = alias ? childRowsOverride[alias] : undefined
      if (!rows) {
        complete = false
        break
      }
      const kept = rows.filter((r) => rowMatches(r, src.filter as FilterSpec | undefined))
      const nums = kept
        .map((r) => Number(r[src.value_field]))
        .filter((n) => Number.isFinite(n))
      let v: number | null = null
      switch (src.aggregate) {
        case 'count':
          v = kept.length
          break
        case 'sum':
          v = nums.length ? nums.reduce((a, b) => a + b, 0) : 0
          break
        case 'avg':
          v = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
          break
        case 'min':
          v = nums.length ? Math.min(...nums) : null
          break
        case 'max':
          v = nums.length ? Math.max(...nums) : null
          break
        default:
          complete = false
      }
      if (!complete) break
      if (v !== null) total = (total ?? 0) + v
    }
    if (complete && total !== null) merged[f.field] = Math.round(total * 100) / 100
  }
  return { item: merged, childRowsOverride, title: info.title }
}
