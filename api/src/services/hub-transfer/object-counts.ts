import { db } from '../../db/index.js'

/**
 * P6-31: how many of the app's stored files live on each non-local provider (`nivaro_files.storage`
 * other than 'local'), e.g. `{ s3: 120 }`. A move to or from a shared deployment changes the key
 * prefix (apps/<tenantId>/ there), so the Hub needs to know whether saved-settings S3/Azure
 * objects must be copied, and whether any provider is one the copy cannot handle. Reported in
 * the `files` part of the hub-link shared-readiness report and of the deployment app status.
 */
export async function objectStorageCounts(): Promise<Record<string, number> | undefined> {
  let rows: Array<{ storage: unknown; n: unknown }>
  try {
    if (!(await db.schema.hasTable('nivaro_files'))) return {}
    // A table from before the column keeps every object on the env provider.
    if (!(await db.schema.hasColumn('nivaro_files', 'storage'))) return {}
    rows = (await db('nivaro_files')
      .whereNotNull('storage')
      .whereNot('storage', 'local')
      .groupBy('storage')
      .select('storage')
      .count({ n: '*' })) as Array<{ storage: unknown; n: unknown }>
  } catch {
    // Unreadable is unknown (left out of the report), never "no objects" (P6-15).
    return undefined
  }
  const out: Record<string, number> = {}
  for (const r of rows) {
    const name = String(r.storage ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 32)
    const n = Number(r.n)
    if (name && name !== 'local' && Number.isFinite(n) && n > 0) out[name] = (out[name] ?? 0) + n
  }
  return out
}

/** The Hub side: a reported `objects` map, or undefined when absent or not one (unknown). */
export function parseObjectCounts(raw: unknown): Record<string, number> | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return undefined
  const out: Record<string, number> = {}
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > 20) return undefined
  for (const [k, v] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(k)) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
    out[k] = Math.floor(v)
  }
  return out
}
