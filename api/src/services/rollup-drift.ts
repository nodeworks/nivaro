import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { computeRollupTotal, parseRollupFormula } from './rollups.js'

/**
 * Stored-rollup drift detection.
 *
 * A stored rollup is a real column kept current by write-path hooks, and two
 * documented facts make silent drift inevitable: chained rollups do not
 * cascade (parent rollup B whose source is rollup A's target stays stale
 * until B's own contributor is written), and every recalc failure is
 * deliberately swallowed so a broken rollup config shows a stale value with
 * zero visible error. Nothing in the system ever went back to CHECK.
 *
 * This sweep recomputes a bounded sample of each stored rollup nightly and
 * compares against the stored column. Drift becomes ONE deduped
 * `nivaro_issues` row per (collection, field) — the same surface operational
 * problems already live on — naming the worst offenders by id so the fix is
 * a targeted `rollup-recalc` backfill, not a hunt.
 *
 * Deliberately a DETECTOR, not a repairer: auto-writing corrections would
 * mask whichever hook or config defect caused the drift, and the write path
 * would just re-drift it. The issue tells a human which rollup is lying;
 * the existing backfill endpoint fixes the rows.
 */

interface StoredRollupField {
  collection: string
  field: string
  computed_formula: string | null
}

export interface DriftReport {
  checked_fields: number
  checked_rows: number
  drifted_rows: number
  fields: Array<{
    collection: string
    field: string
    sampled: number
    drifted: number
    /** Worst offenders: [id, stored, computed]. */
    examples: Array<[string, number | null, number | null]>
  }>
}

/** Rows sampled per rollup field per run. */
const SAMPLE_PER_FIELD = Number(process.env.ROLLUP_DRIFT_SAMPLE ?? 500)
/** Cents-level tolerance — recomputing float sums twice never lands exact. */
const TOLERANCE = 0.005

function differs(stored: unknown, computed: number | null): boolean {
  const s = stored == null ? null : Number(stored)
  if (s === null && computed === null) return false
  // A stored 0 against a computed null (no source rows at all) is the
  // documented write-path behaviour disagreeing with itself; flag it only
  // when the stored value is nonzero — a 0/null split is presentation.
  if (s === null || computed === null) return Math.abs(s ?? computed ?? 0) > TOLERANCE
  return Math.abs(s - computed) > TOLERANCE
}

export async function detectRollupDrift(): Promise<DriftReport> {
  const rows = (await db('nivaro_fields')
    .where({ computed_type: 'rollup' })
    .where((q) => q.where('computed_store', true).orWhere('computed_store', 1))
    .select('collection', 'field', 'computed_formula')) as StoredRollupField[]

  const report: DriftReport = { checked_fields: 0, checked_rows: 0, drifted_rows: 0, fields: [] }

  for (const fieldRow of rows) {
    const cfg = parseRollupFormula(fieldRow.computed_formula)
    if (!cfg) continue
    report.checked_fields++

    let sample: Array<Record<string, unknown>>
    try {
      // Newest rows first: recent writes are where hook regressions show up,
      // and old rows drift once then stay stably wrong — a rotating sample
      // window would re-report the same ancient drift forever.
      sample = (await db(fieldRow.collection)
        .select('id', fieldRow.field)
        .orderBy('id', 'desc')
        .limit(SAMPLE_PER_FIELD)) as Array<Record<string, unknown>>
    } catch {
      continue // table/column gone — the schema-impact story, not this one
    }

    let drifted = 0
    const examples: Array<[string, number | null, number | null]> = []
    for (const row of sample) {
      let computed: number | null
      try {
        computed = await computeRollupTotal(cfg, row.id, fieldRow.collection)
      } catch {
        continue // one row failing to compute must not kill the sweep
      }
      report.checked_rows++
      const stored = row[fieldRow.field]
      if (differs(stored, computed)) {
        drifted++
        if (examples.length < 10) {
          examples.push([String(row.id), stored == null ? null : Number(stored), computed])
        }
      }
    }

    if (drifted > 0) {
      report.drifted_rows += drifted
      report.fields.push({
        collection: fieldRow.collection,
        field: fieldRow.field,
        sampled: sample.length,
        drifted,
        examples
      })
    }
  }

  await reportDrift(report)
  return report
}

/**
 * One open issue per drifting rollup field, deduped by fingerprint the same
 * way server errors are: repeats bump occurrence_count instead of stacking
 * rows, and resolving the issue re-arms it for the next detection.
 */
async function reportDrift(report: DriftReport): Promise<void> {
  for (const f of report.fields) {
    try {
      const fingerprint = createHash('sha256')
        .update(`rollup-drift|${f.collection}|${f.field}`)
        .digest('hex')

      const existing = await db('nivaro_issues')
        .where({ fingerprint })
        .whereIn('status', ['open', 'acknowledged'])
        .first()

      const details = [
        `${f.drifted} of ${f.sampled} sampled rows have a stored value that no longer matches the recomputed rollup.`,
        '',
        'Worst offenders (id: stored → computed):',
        ...f.examples.map(([id, s, c]) => `  ${id}: ${s ?? 'null'} → ${c ?? 'null'}`),
        '',
        `Fix: POST /api/data-model/${f.collection}/fields/${f.field}/rollup-recalc (full backfill),`,
        'then find what stopped keeping it current — a chained rollup, a raw-write path, or a config edit.'
      ].join('\n')

      if (existing) {
        await db('nivaro_issues')
          .where({ id: existing.id })
          .update({
            details,
            occurrence_count: db.raw('occurrence_count + 1'),
            last_seen_at: new Date(),
            updated_at: new Date()
          })
      } else {
        await db('nivaro_issues').insert({
          title: `Rollup drift: ${f.collection}.${f.field} (${f.drifted}/${f.sampled} rows stale)`,
          severity: 'warning',
          status: 'open',
          source: 'server',
          details,
          fingerprint,
          occurrence_count: 1,
          last_seen_at: new Date(),
          created_at: new Date(),
          updated_at: new Date()
        })
      }
    } catch (err) {
      console.warn('rollup-drift issue write failed:', err)
    }
  }
}
