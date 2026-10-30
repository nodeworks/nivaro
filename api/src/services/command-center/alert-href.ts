import { readCcConfig } from './config.js'

/**
 * CC-31 — "Alert me" from any Command Center number: a link to the admin alert editor
 * (/alerts/new) with the definition prefilled from query parameters (AlertEdit reads them:
 * name, category, collection, field, operator, threshold, unit, and one `f.<column>=<value>`
 * per record filter). Alert definitions are admin-only, so only admins are offered the link.
 *
 * The alert engine watches a record field against a threshold, optionally narrowed by
 * column-equality filters — a region focus becomes such a filter only when the region source is a
 * direct field on that same collection (a junction cannot be expressed as an equality filter).
 */
export interface AlertPrefill {
  name: string
  collection: string
  category?: 'general' | 'sla' | 'workflow'
  field?: string
  operator?: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  threshold?: number
  unit?: 'count' | 'percent' | 'dollar' | 'days'
  filters?: Record<string, string>
}

const COLUMN = /^[A-Za-z0-9_]+$/

export function alertPrefillHref(p: AlertPrefill): string {
  const q = new URLSearchParams()
  q.set('from', 'command-center')
  q.set('name', p.name.slice(0, 200))
  if (COLUMN.test(p.collection)) q.set('collection', p.collection)
  if (p.category) q.set('category', p.category)
  if (p.field && COLUMN.test(p.field)) q.set('field', p.field)
  if (p.operator) q.set('operator', p.operator)
  if (p.threshold != null && Number.isFinite(p.threshold)) q.set('threshold', String(p.threshold))
  if (p.unit) q.set('unit', p.unit)
  for (const [k, v] of Object.entries(p.filters ?? {}))
    if (COLUMN.test(k)) q.set(`f.${k}`, String(v).slice(0, 200))
  return `/alerts/new?${q.toString()}`
}

/** The equality filter that places a record of `collection` in region `regionId`, if any. */
export async function regionAlertFilter(
  regionId: string
): Promise<{ collection: string; field: string; value: string } | null> {
  try {
    const cfg = await readCcConfig()
    const r = cfg.region
    if (r === false || r?.via.kind !== 'field') return null
    return { collection: r.via.item_collection, field: r.via.field, value: regionId }
  } catch {
    return null
  }
}
