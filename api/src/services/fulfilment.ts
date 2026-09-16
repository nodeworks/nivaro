import { db } from '../db/index.js'
import { getCollection } from './collections.js'
import { selectInChunks } from './db-batch.js'

/**
 * #7 — a collection's fulfilment figures (how much of a request has shipped),
 * declared per collection in `nivaro_collections.browser_config.fulfilment`:
 *
 *   { shipped_field, requested_field, remaining_field?, label? }
 *
 * The fields are plain columns (typically stored rollups over the request's
 * lines). Queues and the collection browser derive one status per record —
 * none / partial / complete — and offer a "shipped n/m" column with a filter.
 * Nothing here knows which warehouse or integration fills the columns.
 */
export interface FulfilmentConfig {
  shipped_field: string
  requested_field: string
  /** requested − shipped as its own column — lets the browser filter
   *  "complete" server-side (a column-vs-column compare has no filter op). */
  remaining_field?: string | null
  label?: string | null
}

export type FulfilmentStatus = 'none' | 'partial' | 'complete'

export interface FulfilmentFigures {
  shipped: number
  requested: number
  status: FulfilmentStatus
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseFulfilmentConfig(browserConfig: unknown): FulfilmentConfig | null {
  try {
    const bc =
      typeof browserConfig === 'string'
        ? (JSON.parse(browserConfig) as Record<string, unknown>)
        : (browserConfig as Record<string, unknown> | null)
    const f = bc?.fulfilment as Record<string, unknown> | undefined
    if (!f || typeof f !== 'object') return null
    const shipped = String(f.shipped_field ?? '')
    const requested = String(f.requested_field ?? '')
    if (!IDENT.test(shipped) || !IDENT.test(requested)) return null
    const remaining = f.remaining_field != null ? String(f.remaining_field) : null
    return {
      shipped_field: shipped,
      requested_field: requested,
      remaining_field: remaining && IDENT.test(remaining) ? remaining : null,
      label: f.label != null ? String(f.label).slice(0, 60) : null
    }
  } catch {
    return null
  }
}

/** The collection's fulfilment config, or null when it declares none. */
export async function fulfilmentConfigFor(collection: string): Promise<FulfilmentConfig | null> {
  try {
    const meta = (await getCollection(collection)) as { browser_config?: unknown } | null
    return parseFulfilmentConfig(meta?.browser_config)
  } catch {
    return null
  }
}

export function fulfilmentStatus(shipped: number, requested: number): FulfilmentStatus {
  if (!(shipped > 0)) return 'none'
  return requested > 0 && shipped >= requested ? 'complete' : 'partial'
}

/** Figures per record — one chunked read of the two columns. */
export async function fulfilmentBatch(
  collection: string,
  ids: string[],
  cfg: FulfilmentConfig
): Promise<Map<string, FulfilmentFigures>> {
  const out = new Map<string, FulfilmentFigures>()
  if (ids.length === 0) return out
  const rows = (await selectInChunks<Record<string, unknown>, string>(ids, 2000, (chunk) =>
    db(collection).whereIn('id', chunk).select('id', cfg.shipped_field, cfg.requested_field)
  ).catch(() => [])) as Array<Record<string, unknown>>
  for (const r of rows) {
    const shipped = Number(r[cfg.shipped_field] ?? 0) || 0
    const requested = Number(r[cfg.requested_field] ?? 0) || 0
    out.set(String(r.id), { shipped, requested, status: fulfilmentStatus(shipped, requested) })
  }
  return out
}
