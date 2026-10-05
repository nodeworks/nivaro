import { db } from '../../../db/index.js'
import { computeRollupTotal, type NormalizedRollup, parseRollupFormula } from '../../rollups.js'
import { type Candidate, IDENT, KIND_RISK } from '../types.js'

/**
 * Rollup-store observer: a virtual rollup is recomputed on every read. When the reads cost at
 * least three times what keeping a stored copy current would (one recalc per child write), the
 * field is proposed for `computed_store`. Apply/undo flip the field flag only.
 */

export interface RollupField {
  collection: string
  field: string
  child: string
  readsPerDay: number
  writesPerDay: number
  perReadMs: number
  perRecalcMs: number
}
export interface RollupEvidence {
  fields: RollupField[]
}

export const MIN_READS_PER_DAY = 200
const LIST_PAGE_ROWS = 25
const SAMPLE_ROWS = 20

export function observeRollupStore(ev: RollupEvidence): Candidate[] {
  const out: Candidate[] = []
  for (const f of ev.fields) {
    if (f.readsPerDay < MIN_READS_PER_DAY) continue
    const readCost = f.readsPerDay * f.perReadMs
    const upkeep = f.writesPerDay * f.perRecalcMs
    if (readCost < 3 * upkeep) continue
    out.push({
      kind: 'rollup_store',
      target: `${f.collection}.${f.field}`,
      change_key: 'store',
      title: `Store ${f.collection}.${f.field} — ${Math.round(f.readsPerDay)} reads/day recompute it from ${f.child}`,
      evidence: {
        reads_per_day: Math.round(f.readsPerDay),
        writes_per_day: Math.round(f.writesPerDay),
        per_read_ms: f.perReadMs,
        per_recalc_ms: f.perRecalcMs,
        child: f.child
      },
      estimate_ms_per_day: Math.round(readCost - upkeep),
      risk: KIND_RISK.rollup_store,
      apply: {
        type: 'field_patch',
        collection: f.collection,
        field: f.field,
        patch: { computed_store: true }
      },
      undo: {
        type: 'field_patch',
        collection: f.collection,
        field: f.field,
        patch: { computed_store: false }
      }
    })
  }
  return out
}

/**
 * The parsed config of a rollup that may be proposed for storing, or null: already stored, not an
 * identifier, a system collection, or a recursive (tree) rollup — the stored path recalcs on a
 * direct child's write, so descendant writes would leave a stored tree total stale.
 */
export function storableRollup(r: {
  collection: string
  field: string
  computed_formula: string | null
  computed_store: unknown
}): NormalizedRollup | null {
  if (r.computed_store) return null
  if (!IDENT.test(r.collection) || !IDENT.test(r.field)) return null
  if (/^nivaro_/i.test(r.collection)) return null
  const cfg = parseRollupFormula(r.computed_formula)
  if (!cfg?.sources.length) return null
  if (cfg.sources.some((s) => s.recursive)) return null
  return cfg
}

const countOf = (row: { n: number | string } | undefined): number => Number(row?.n ?? 0) || 0

export async function loadRollupEvidence(): Promise<RollupEvidence> {
  const rows = (await db('nivaro_fields')
    .where('computed_type', 'rollup')
    .select('collection', 'field', 'computed_formula', 'computed_store')
    .catch(() => [])) as Array<{
    collection: string
    field: string
    computed_formula: string | null
    computed_store: unknown
  }>
  const since = new Date(Date.now() - 7 * 86_400_000)
  const fields: RollupField[] = []
  for (const r of rows) {
    const cfg = storableRollup(r)
    if (!cfg) continue
    const children = [...new Set(cfg.sources.map((s) => s.related_collection))]
    // reads: list reads of the collection in the last 7 days that asked for this field (or all)
    const reads = (await db('nivaro_api_logs')
      .where('method', 'GET')
      .where('path', `/api/items/${r.collection}`)
      .where('created_at', '>', since)
      .where((q) =>
        q
          .whereNull('query')
          .orWhereNot('query', 'like', '%fields=%')
          .orWhere('query', 'like', `%${r.field}%`)
      )
      .count({ n: '*' })
      .first()
      .catch(() => ({ n: 0 }))) as { n: number | string } | undefined
    // upkeep: every write to any source collection recalculates the stored copy
    const writes = (await db('nivaro_activity')
      .whereIn('collection', children)
      .whereIn('action', ['create', 'update', 'delete'])
      .where('timestamp', '>', since)
      .count({ n: '*' })
      .first()
      .catch(() => ({ n: 0 }))) as { n: number | string } | undefined
    const sample = (await db(r.collection)
      .select('id')
      .orderBy('id', 'desc')
      .limit(SAMPLE_ROWS)
      .catch(() => [])) as Array<{ id: unknown }>
    if (!sample.length) continue
    // a compute that throws would time as fast and understate the read cost: skip the field
    const t0 = Date.now()
    let failed = false
    for (const s of sample) {
      failed = await computeRollupTotal(cfg, s.id, r.collection).then(
        () => false,
        () => true
      )
      if (failed) break
    }
    if (failed) continue
    const perRecalcMs = (Date.now() - t0) / sample.length
    fields.push({
      collection: r.collection,
      field: r.field,
      child: children[0],
      readsPerDay: countOf(reads) / 7,
      writesPerDay: countOf(writes) / 7,
      perReadMs: perRecalcMs * LIST_PAGE_ROWS,
      perRecalcMs
    })
  }
  return { fields }
}
