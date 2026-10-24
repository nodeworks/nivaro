import { db, isMssql } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { getTenantId } from '../db/tenant-context.js'
import type { CMSRelation } from '../types.js'

/**
 * Which registered names have a table behind them. `nivaro_collections` and
 * `nivaro_relations` are claims, not truth: a registered collection or a
 * relation's junction whose table was never built (forecasts_regions) used to
 * reach SQL and come back as a 500 "Invalid object name". One catalog read
 * (tables, views, synonyms) per tenant a minute answers every such question;
 * a name missing from the list is looked up afresh (then believed missing for
 * ten seconds), so a table created a moment ago is not refused.
 *
 * Fail-open: when the catalog cannot be read (or the dialect is not MSSQL)
 * nothing is judged missing.
 */

const TTL_MS = 60_000
/** How long a confirmed-missing name is believed before the catalog is asked again. */
const CONFIRM_MS = 10_000
const cache = new Map<string, { at: number; names: Set<string> }>()
/** `<tenant>:<name>` → when a fresh catalog read confirmed it missing. */
const confirmedMissing = new Map<string, number>()

/** Every table/view/synonym as `schema.name`, plus the bare `name` for what
 *  an unqualified collection resolves to: SQL Server looks in the login's
 *  default schema first, then in dbo — so both give bare names. */
async function loadNames(): Promise<Set<string> | null> {
  try {
    if (!isMssql()) return null
    const rows = rawRows<{ s: string; name: string; d: number | boolean }>(
      await db.raw(
        `SELECT SCHEMA_NAME(schema_id) AS s, name,
                CASE WHEN schema_id = SCHEMA_ID() THEN 1 ELSE 0 END AS d
           FROM sys.objects WHERE type IN ('U', 'V', 'SN')`
      )
    )
    // A database with no tables at all is a catalog read that went wrong.
    if (rows.length === 0) return null
    const out = new Set<string>()
    for (const r of rows) {
      const name = String(r.name).toLowerCase()
      const schema = String(r.s).toLowerCase()
      out.add(`${schema}.${name}`)
      if (r.d === 1 || r.d === true || schema === 'dbo') out.add(name)
    }
    return out
  } catch {
    return null
  }
}

/** One catalog read per tenant at a time: a cold or expired cache under load
 *  otherwise sent one read per concurrent request (4 at once on one export). */
const inflight = new Map<string, Promise<Set<string> | null>>()

async function names(): Promise<Set<string> | null> {
  const key = getTenantId() ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names
  let pending = inflight.get(key)
  if (!pending) {
    pending = loadNames().finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  const loaded = await pending
  if (loaded) cache.set(key, { at: Date.now(), names: loaded })
  return loaded ?? hit?.names ?? null
}

/** True only when the catalog was read and has no table/view/synonym of this
 *  name (bare = the default schema, or `schema.name`). */
export async function tableIsMissing(name: string): Promise<boolean> {
  const n = name.toLowerCase().replace(/[[\]]/g, '')
  const set = await names()
  if (!set || set.has(n)) return false
  const key = `${getTenantId() ?? ''}:${n}`
  const confirmed = confirmedMissing.get(key)
  if (confirmed && Date.now() - confirmed < CONFIRM_MS) return true
  // Confirm against a FRESH read only — a failed re-read is no evidence, and
  // the cached list may predate a table created a moment ago.
  const fresh = await loadNames()
  if (!fresh) return false
  cache.set(getTenantId() ?? '', { at: Date.now(), names: fresh })
  if (fresh.has(n)) return false
  if (confirmedMissing.size >= 5000) confirmedMissing.clear()
  confirmedMissing.set(key, Date.now())
  return true
}

/** Relations whose tables all exist (M2A legs name no one_collection and keep). */
export async function liveRelations(rels: CMSRelation[]): Promise<CMSRelation[]> {
  if (rels.length === 0) return rels
  const tables = new Set<string>()
  for (const r of rels) {
    if (r.many_collection) tables.add(r.many_collection)
    if (r.one_collection) tables.add(r.one_collection)
  }
  const missing = new Set<string>()
  for (const t of tables) if (await tableIsMissing(t)) missing.add(t)
  if (missing.size === 0) return rels
  return rels.filter(
    (r) =>
      !(r.many_collection && missing.has(r.many_collection)) &&
      !(r.one_collection && missing.has(r.one_collection))
  )
}

/** Test seam. */
export function resetPhysicalTablesCache(): void {
  cache.clear()
  confirmedMissing.clear()
  inflight.clear()
}
