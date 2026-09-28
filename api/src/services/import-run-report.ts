import type { ImportRunItem, ImportRunPhase, ImportRunUnmatched } from '@nivaro/extension-kit'
import { db } from '../db/index.js'

export type {
  ImportRunChange,
  ImportRunItem,
  ImportRunItemKind,
  ImportRunPhase,
  ImportRunUnmatched
} from '@nivaro/extension-kit'

/**
 * What an import run did, stored so the run can be read and drilled into
 * afterwards (migration 359).
 *
 * The REPORT is the run as a whole: counts, where the time went, which
 * reference values in the file matched nothing. The ITEMS are one row per
 * record the run created or changed and per file row it left out.
 *
 * Writing either is best effort. A run that imported its rows is a completed
 * run whether or not its report could be stored.
 */

export interface ImportRunReport {
  counts: {
    created: number
    updated: number
    unchanged: number
    skipped: number
    failed: number
    /** Anything the four buckets do not cover ('base / tax split filled'). */
    other?: Array<{ label: string; count: number }>
  }
  /** Rows left out, per reason. */
  skipped: Record<string, number>
  phases: ImportRunPhase[]
  unmatched: ImportRunUnmatched[]
  notes: string[]
  /** Per collection: how many records were created and changed. */
  collections?: Record<string, { created: number; updated: number }>
  items_stored?: number
  /** True when the run touched more records than are kept per run. */
  items_truncated?: boolean
}

export const MAX_ITEMS_PER_RUN = 50_000
const INSERT_CHUNK = 200
const KEEP_DAYS = 90

let columns: { at: number; ok: boolean } | null = null

/** Whether this database has migration 359. A hit is remembered; a miss is
 *  asked again after a minute. */
export async function hasRunReports(): Promise<boolean> {
  if (columns?.ok) return true
  if (columns && Date.now() - columns.at < 60_000) return false
  try {
    const ok =
      (await db.schema.hasColumn('nivaro_import_queue', 'report')) &&
      (await db.schema.hasTable('nivaro_import_run_items'))
    columns = { at: Date.now(), ok }
    return ok
  } catch {
    columns = { at: Date.now(), ok: false }
    return false
  }
}

const clip = (v: unknown, max: number): string | null => {
  if (v == null) return null
  const s = String(v)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** A value short enough to store and show; long text is cut, objects are JSON. */
function storable(v: unknown): unknown {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return clip(JSON.stringify(v), 400)
  if (typeof v === 'string') return clip(v, 400)
  return v
}

export async function recordRanVia(runId: number, ranVia: string): Promise<void> {
  try {
    if (!(await hasRunReports())) return
    await db('nivaro_import_queue')
      .where('id', runId)
      .update({ ran_via: ranVia.slice(0, 160) })
  } catch {
    // best effort
  }
}

export async function saveRunReport(
  runId: number,
  report: ImportRunReport,
  items: ImportRunItem[]
): Promise<void> {
  try {
    if (!(await hasRunReports())) return
    const kept = items.slice(0, MAX_ITEMS_PER_RUN)
    const now = new Date()
    // A re-run under the same queue row replaces what the earlier attempt stored.
    await db('nivaro_import_run_items').where('run', runId).del()
    for (let i = 0; i < kept.length; i += INSERT_CHUNK) {
      await db('nivaro_import_run_items').insert(
        kept.slice(i, i + INSERT_CHUNK).map((it) => ({
          run: runId,
          kind: it.kind,
          collection: it.collection ?? null,
          item_id: it.item_id == null ? null : String(it.item_id),
          label: clip(it.label, 500),
          file_row: it.row ?? null,
          message: clip(it.message, 1000),
          changes:
            it.changes && it.changes.length > 0
              ? JSON.stringify(
                  it.changes
                    .slice(0, 60)
                    .map((c) => ({ field: c.field, from: storable(c.from), to: storable(c.to) }))
                )
              : null,
          created_at: now
        }))
      )
    }
    const stored: ImportRunReport = {
      ...report,
      items_stored: kept.length,
      items_truncated: items.length > kept.length
    }
    await db('nivaro_import_queue')
      .where('id', runId)
      .update({ report: JSON.stringify(stored) })
    // Old detail goes; the queue row and its report stay.
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000)
    await db.raw('DELETE TOP (20000) FROM nivaro_import_run_items WHERE created_at < ?', [cutoff])
  } catch {
    // best effort — the run itself has already landed
  }
}

export function parseRunReport(raw: unknown): ImportRunReport | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!v || typeof v !== 'object' || !('counts' in v)) return null
    return v as ImportRunReport
  } catch {
    return null
  }
}

/**
 * Rebuild a run's items from the activity its writes left behind.
 *
 * Every write an items-service import makes carries the stamp
 * `import:<label>:run-<id>`, so a run that finished before reports existed —
 * or whose report could not be stored — can still be read. What the activity
 * cannot give back: rows the run left out, unmatched values and timings, and
 * the value a field held BEFORE the change (a revision keeps the new value).
 */
export async function rebuildRunReport(runId: number): Promise<{ items: number } | null> {
  if (!(await hasRunReports())) return null
  const rows = (await db('nivaro_activity as a')
    .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
    .where('a.comment', 'like', `import:%:run-${runId}`)
    .whereIn('a.action', ['create', 'update'])
    .orderBy('a.id', 'asc')
    .limit(MAX_ITEMS_PER_RUN)
    .select('a.action', 'a.collection', 'a.item', 'r.delta')) as Array<{
    action: string
    collection: string
    item: string
    delta: string | null
  }>
  if (rows.length === 0) return { items: 0 }
  const HOUSEKEEPING = new Set(['changed', 'created', 'updated_at', 'date_updated', 'id'])
  const items: ImportRunItem[] = rows.map((r) => {
    let delta: Record<string, unknown> = {}
    try {
      delta = r.delta ? (JSON.parse(r.delta) as Record<string, unknown>) : {}
    } catch {
      delta = {}
    }
    return {
      kind: r.action === 'create' ? 'created' : 'updated',
      collection: r.collection,
      item_id: r.item,
      label: '',
      changes: Object.entries(delta)
        .filter(([k, v]) => !HOUSEKEEPING.has(k) && !k.startsWith('_') && v != null)
        .map(([field, to]) => ({ field, from: undefined, to }))
    }
  })
  const collections: Record<string, { created: number; updated: number }> = {}
  for (const it of items) {
    const c = (collections[String(it.collection)] ??= { created: 0, updated: 0 })
    if (it.kind === 'created') c.created++
    else c.updated++
  }
  const created = items.filter((i) => i.kind === 'created').length
  await saveRunReport(
    runId,
    {
      counts: { created, updated: items.length - created, unchanged: 0, skipped: 0, failed: 0 },
      skipped: {},
      phases: [],
      unmatched: [],
      notes: [
        'Rebuilt from the changes this run recorded. Rows it left unchanged or left out, timings, and the values fields held before the change were not kept at the time.'
      ],
      collections
    },
    items
  )
  return { items: items.length }
}
