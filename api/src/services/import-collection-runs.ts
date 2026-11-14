import { db } from '../db/index.js'
import { parseRecalcRollups } from './import-rollups.js'
import { getIo } from './io-holder.js'
import type { ImportDefinition } from './staged-imports.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * #1826 — "an import is running" on the pages of the collections a PROCEDURE-mode staged
 * import writes.
 *
 * An items-service import writes record by record, so each record event says
 * `source: 'import'` and the record page shows "An import is updating this record". A
 * procedure run writes set-based inside one EXEC: no record events until it finishes, and no
 * row-level progress at all. So these runs are announced per COLLECTION instead — the
 * collections the definition says the procedure writes (`recalc_rollups`, #719) — with the
 * run's start time, and when it ends, its outcome and the rows the run reported.
 *
 * State lives in `nivaro_import_queue` (status / started_at / finished_at / row_count), so
 * every replica answers the same. The socket event carries ids and the status only; pages
 * read the run itself through GET /staged-imports/collection-runs (collection read access).
 */

export const IMPORT_COLLECTION_EVENT = 'import:collection'

/** How long a finished run stays on the pages after it ends. */
export const RECENT_FINISH_MS = 10 * 60_000

/** A run that has been "running" this long is treated as abandoned (process died mid-run). */
const STALE_RUNNING_MS = 12 * 60 * 60_000

const CACHE_MS = 3_000

export type CollectionImportStatus = 'running' | 'completed' | 'error'

export interface CollectionImportRun {
  run_id: string
  label: string
  status: CollectionImportStatus
  started_at: string | null
  finished_at: string | null
  /** Completed runs: the rows the run reported (the file's rows for a procedure run). */
  rows: number | null
}

/** Whether a definition's runs take the procedure path (not the items service / a processor). */
export function runsAsProcedure(
  def: Pick<ImportDefinition, 'procedure' | 'processor'>,
  processorRegistered: (name: string) => boolean
): boolean {
  if (!def.procedure) return false
  const p = def.processor?.trim()
  if (!p || p === 'proc') return true
  if (p === 'service') return false
  // A named processor that did not load here falls back to the procedure (staged-imports.ts).
  return !processorRegistered(p)
}

/** The collections a procedure-mode run writes; [] for any other mode. */
export function procImportCollections(
  def: Pick<ImportDefinition, 'procedure' | 'processor' | 'recalc_rollups'>,
  processorRegistered: (name: string) => boolean
): string[] {
  return runsAsProcedure(def, processorRegistered) ? parseRecalcRollups(def.recalc_rollups) : []
}

function iso(v: unknown): string | null {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function prettyKey(key: string): string {
  return key
    .split('_')
    .map((v) => v.charAt(0).toUpperCase() + v.slice(1))
    .join(' ')
}

/**
 * The procedure-mode runs to show on `collection`'s pages: running ones, and ones that ended
 * within RECENT_FINISH_MS. Newest first. Pure — the caller reads the queue and definitions.
 */
export function buildCollectionImportRuns(
  queueRows: Array<Record<string, unknown>>,
  defs: Array<
    Pick<ImportDefinition, 'key' | 'label' | 'procedure' | 'processor' | 'recalc_rollups'>
  >,
  collection: string,
  now: number,
  processorRegistered: (name: string) => boolean
): CollectionImportRun[] {
  const want = collection.toLowerCase()
  const byKey = new Map(defs.map((d) => [String(d.key).toLowerCase(), d]))
  const out: CollectionImportRun[] = []
  for (const r of queueRows) {
    const def = byKey.get(String(r.import_key ?? '').toLowerCase())
    if (!def) continue
    const targets = procImportCollections(def, processorRegistered).map((c) => c.toLowerCase())
    if (!targets.includes(want)) continue
    const status = String(r.status)
    const started = iso(r.started_at)
    const finished = iso(r.finished_at)
    if (status === 'running') {
      if (started && now - new Date(started).getTime() > STALE_RUNNING_MS) continue
    } else if (status === 'completed' || status === 'error') {
      if (!finished || now - new Date(finished).getTime() > RECENT_FINISH_MS) continue
    } else continue
    out.push({
      run_id: String(r.id),
      label: def.label ? String(def.label) : prettyKey(String(def.key)),
      status: status as CollectionImportStatus,
      started_at: started,
      finished_at: status === 'running' ? null : finished,
      rows: status === 'completed' && r.row_count != null ? Number(r.row_count) : null
    })
  }
  const at = (x: CollectionImportRun) => new Date(x.finished_at ?? x.started_at ?? 0).getTime()
  return out.sort((a, b) => at(b) - at(a))
}

async function processorRegisteredFn(): Promise<(name: string) => boolean> {
  try {
    const { getImportProcessor } = await import('./import-processors.js')
    return (name) => !!getImportProcessor(name)
  } catch {
    return () => false
  }
}

// Per tenant (cloud tenants share this process): the queue + definitions read, a few seconds old.
const caches = new Map<
  string,
  { at: number; rows: Array<Record<string, unknown>>; defs: ImportDefinition[] }
>()

/** The runs for one collection's pages. One small queue read per process every few seconds. */
export async function listCollectionImportRuns(
  collection: string,
  now = Date.now()
): Promise<CollectionImportRun[]> {
  const tenant = currentTenantKey()
  let cache = caches.get(tenant)
  if (!cache || now - cache.at > CACHE_MS) {
    const since = new Date(now - RECENT_FINISH_MS)
    const [rows, defs] = await Promise.all([
      db('nivaro_import_queue')
        .where((qb) => {
          qb.where('status', 'running').orWhere((q2) =>
            q2.whereIn('status', ['completed', 'error']).where('finished_at', '>=', since)
          )
        })
        .select('id', 'import_key', 'status', 'started_at', 'finished_at', 'row_count')
        .limit(200) as Promise<Array<Record<string, unknown>>>,
      db('nivaro_import_definitions')
        .whereNotNull('procedure')
        .select('key', 'label', 'procedure', 'processor', 'recalc_rollups') as Promise<
        ImportDefinition[]
      >
    ])
    cache = { at: now, rows, defs }
    caches.set(tenant, cache)
  }
  return buildCollectionImportRuns(
    cache.rows,
    cache.defs,
    collection,
    now,
    await processorRegisteredFn()
  )
}

/** Test seam. */
export function resetCollectionImportRunsCache(): void {
  caches.clear()
}

/**
 * Tell the open pages of a procedure-mode run's collections that it started or ended. Ids and
 * the status only — pages read the run through the permission-checked route. Never throws.
 */
export function announceCollectionImport(
  def: Pick<ImportDefinition, 'procedure' | 'processor' | 'recalc_rollups'>,
  runId: string | number,
  status: CollectionImportStatus,
  processorRegistered: (name: string) => boolean
): string[] {
  caches.delete(currentTenantKey())
  const collections = procImportCollections(def, processorRegistered)
  const io = getIo()
  if (!io) return collections
  for (const collection of collections) {
    try {
      io.to(tenantScopedRoom(`collection:${collection}`)).emit(IMPORT_COLLECTION_EVENT, {
        collection,
        run_id: String(runId),
        status
      })
    } catch {
      /* decoration — never breaks the run */
    }
  }
  return collections
}

/** Same as announceCollectionImport, resolving which processors are registered here. */
export async function announceCollectionImportRun(
  def: Pick<ImportDefinition, 'procedure' | 'processor' | 'recalc_rollups'>,
  runId: string | number,
  status: CollectionImportStatus
): Promise<void> {
  try {
    announceCollectionImport(def, runId, status, await processorRegisteredFn())
  } catch {
    /* decoration */
  }
}
