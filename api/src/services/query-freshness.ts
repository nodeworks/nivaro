import { createHash } from 'node:crypto'
import { inThisSchema } from '../db/dialect/h1.js'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { readSetOf } from './sql-read-set.js'

function parseJson<T>(raw: string | null): T | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Staleness in business terms (#500).
 *
 * "Updated 3m ago" says how old a cached figure is; a budget reviewer wants
 * to know whether an invoice landed AFTER it was computed. Each custom query
 * names (or has inferred) the tables whose newest write decides that, and
 * the execute response carries `data_changed_at` — the newest of those
 * writes — beside `cached_at`, so a stamp can say "invoices changed 4m ago,
 * newer than this figure" and offer the refresh that matters.
 *
 * Sources are `[{table, column}]` where column is the table's last-write
 * timestamp. When a query declares none they are inferred once per query
 * from its SQL: tables named after FROM / JOIN — and, for an `EXEC proc`,
 * inside that procedure's own text — that carry a recognised timestamp
 * column. A table without one cannot vouch for itself and is left out.
 *
 * A declared source may add `newest_by` (an indexed key, normally `id`): the
 * probe then reads `column` of the newest row by that key (TOP 1 … ORDER BY
 * key DESC, a seek) instead of MAX(column), which scans the table when
 * `column` has no index (inventory_item_transactions: 2M rows, ~350 ms per
 * probe on production). It sees new rows, not later edits to old ones — the
 * cache's own lifetime still covers those.
 */

export interface FreshnessSource {
  table: string
  column: string
  /** Probe the newest row by this indexed key instead of MAX(column). */
  newest_by?: string
}

export interface FreshnessFact extends FreshnessSource {
  changed_at: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** In order of preference when a table has several. */
const TIMESTAMP_COLUMNS = [
  'updated_at',
  'date_updated',
  'changed',
  'modified_at',
  'last_updated',
  'updated',
  'modified',
  'created_at',
  'date_created',
  'created'
]
const MAX_SOURCES = 8

export function parseFreshnessSources(raw: string | null | undefined): FreshnessSource[] | null {
  const parsed = parseJson<unknown>(raw ?? null)
  if (!Array.isArray(parsed)) return null
  const out: FreshnessSource[] = []
  for (const e of parsed) {
    const t = String((e as { table?: unknown })?.table ?? '')
    const c = String((e as { column?: unknown })?.column ?? '')
    const by = (e as { newest_by?: unknown })?.newest_by
    if (!IDENT.test(t) || !IDENT.test(c)) continue
    if (typeof by === 'string' && IDENT.test(by)) out.push({ table: t, column: c, newest_by: by })
    else out.push({ table: t, column: c })
  }
  return out.slice(0, MAX_SOURCES)
}

// ─── Catalog: which tables have which timestamp column (10-min cache) ────────

let catalog: { at: number; value: Promise<Map<string, string>> } | null = null
const CATALOG_TTL = 10 * 60_000

async function timestampCatalog(): Promise<Map<string, string>> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL) return catalog.value
  const value = (async () => {
    const map = new Map<string, string>()
    try {
      const mssql = isMssql(db)
      const rows = (await db('information_schema.columns')
        .whereIn('column_name', TIMESTAMP_COLUMNS)
        .whereIn(
          'data_type',
          mssql
            ? ['datetime', 'datetime2', 'date', 'smalldatetime', 'datetimeoffset']
            : [
                'datetime',
                'date',
                'timestamp',
                'timestamp without time zone',
                'timestamp with time zone'
              ]
        )
        .whereRaw(`1 = 1${inThisSchema(db, 'table_schema')}`)
        .select('table_name as table_name', 'column_name as column_name')) as Array<{
        table_name: string
        column_name: string
      }>
      const rank = new Map(TIMESTAMP_COLUMNS.map((c, i) => [c, i]))
      for (const r of rows) {
        const t = r.table_name.toLowerCase()
        const cur = map.get(t)
        if (!cur || (rank.get(r.column_name.toLowerCase()) ?? 99) < (rank.get(cur) ?? 99)) {
          map.set(t, r.column_name.toLowerCase())
        }
      }
    } catch {
      /* no catalog access — nothing can be inferred */
    }
    return map
  })()
  catalog = { at: Date.now(), value }
  return value
}

// ─── Inference from SQL (per query, 10-min cache) ───────────────────────────

const TABLE_REF =
  /\b(?:from|join|into|update)\s+[[`"]?(?:(?:dbo|public)[\]`"]?\.[[`"]?)?([A-Za-z_][A-Za-z0-9_]*)[\]`"]?/gi
const EXEC_REF = /\bexec(?:ute)?\s+\[?(?:dbo\]?\.\[?)?([A-Za-z_][A-Za-z0-9_]*)\]?/gi
const SKIP = /^(nivaro_|sys|information_schema|staging_|zz_|temp_|#)/i

function tablesIn(sql: string): Set<string> {
  const out = new Set<string>()
  for (const m of sql.matchAll(TABLE_REF)) out.add(m[1].toLowerCase())
  return out
}

export async function procedureText(name: string): Promise<string | null> {
  if (!IDENT.test(name)) return null
  if (!isMssql(db)) return null // stored procedures: SQL Server only
  try {
    const rows = (await db.raw(
      'SELECT m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id WHERE o.name = ? AND o.type IN (?, ?)',
      [name, 'P', 'FN']
    )) as Array<{ definition: string }>
    return rows?.[0]?.definition ?? null
  } catch {
    return null
  }
}

/**
 * Every table a query reads — through views, functions and procedures, several
 * levels deep (services/sql-read-set.ts) — minus system / staging / scratch
 * tables. Shared with the raw-SQL scope coverage report (#770), which needs the
 * tables, not their clocks. What could not be followed is dropped here; the
 * scope gate reads `readSetOf` itself so it can refuse on it.
 */
export async function tablesReadBy(sql: string): Promise<string[]> {
  return (await readSetOf(sql)).tables
}

const inferred = new Map<string, { at: number; value: Promise<FreshnessSource[]> }>()

export async function inferFreshnessSources(
  queryKey: string,
  sql: string
): Promise<FreshnessSource[]> {
  const hit = inferred.get(queryKey)
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.value
  const value = (async () => {
    const tables = tablesIn(sql)
    // One level into procedures the query EXECs — the rpt-* wrappers are all
    // INSERT … EXEC over a procedure that names the real tables.
    const procs = [...sql.matchAll(EXEC_REF)].map((m) => m[1]).slice(0, 4)
    for (const p of procs) {
      const text = await procedureText(p)
      if (text) for (const t of tablesIn(text)) tables.add(t)
    }
    const cat = await timestampCatalog()
    const out: FreshnessSource[] = []
    for (const t of tables) {
      if (SKIP.test(t)) continue
      const col = cat.get(t)
      if (col) out.push({ table: t, column: col })
    }
    return out.slice(0, MAX_SOURCES)
  })()
  inferred.set(queryKey, { at: Date.now(), value })
  return value
}

export function bustFreshnessInference(): void {
  inferred.clear()
}

// ─── The newest write per source (60s cache per source) ─────────────────────

const newest = new Map<string, { at: number; value: Promise<string | null> }>()
const NEWEST_TTL = 60_000

async function newestWrite(src: FreshnessSource): Promise<string | null> {
  const key = `${src.table}.${src.column}${src.newest_by ? `@${src.newest_by}` : ''}`
  const hit = newest.get(key)
  if (hit && Date.now() - hit.at < NEWEST_TTL) return hit.value
  const value = (async () => {
    try {
      const row = (await (src.newest_by
        ? db(src.table).select(`${src.column} as v`).orderBy(src.newest_by, 'desc').first()
        : db(src.table).max(`${src.column} as v`).first())) as { v: unknown } | undefined
      const v = row?.v
      if (v instanceof Date) return v.toISOString()
      if (typeof v === 'string' && v) {
        const t = Date.parse(v)
        return Number.isNaN(t) ? null : new Date(t).toISOString()
      }
      return null
    } catch {
      return null
    }
  })()
  newest.set(key, { at: Date.now(), value })
  return value
}

export interface Freshness {
  data_changed_at: string | null
  sources: FreshnessFact[]
}

/** Resolve the freshness facts for a query: declared sources, else inferred. */
export async function queryFreshness(query: {
  id: unknown
  sql_text?: string | null
  freshness_sources?: string | null
}): Promise<Freshness> {
  const declared = parseFreshnessSources(query.freshness_sources)
  const sources =
    declared && declared.length
      ? declared
      : await inferFreshnessSources(String(query.id), query.sql_text ?? '')
  const facts = await Promise.all(
    sources.map(async (s) => ({ ...s, changed_at: await newestWrite(s) }))
  )
  let latest: string | null = null
  for (const f of facts)
    if (f.changed_at && (!latest || f.changed_at > latest)) latest = f.changed_at
  return { data_changed_at: latest, sources: facts }
}

// ─── Live sources: the collections a query reads, cached or not ─────────────

const COLLECTION_NAMES_TTL = 60_000
let collectionNames: { at: number; value: Promise<Map<string, string>> } | null = null

/** Registered collections by lower-case name (60 s cache). */
async function registeredCollections(): Promise<Map<string, string>> {
  if (collectionNames && Date.now() - collectionNames.at < COLLECTION_NAMES_TTL)
    return collectionNames.value
  const value = (async () => {
    const map = new Map<string, string>()
    try {
      const rows = (await db('nivaro_collections').select('collection')) as Array<{
        collection: string
      }>
      for (const r of rows) map.set(String(r.collection).toLowerCase(), r.collection)
    } catch {
      /* no registry read: nothing maps, so no chip */
    }
    return map
  })()
  collectionNames = { at: Date.now(), value }
  return value
}

const liveInferred = new Map<string, { at: number; value: Promise<string[]> }>()
const LIVE_TTL = 10 * 60_000

/** Short stable stamp of what decides a query's tables: its SQL and its declared sources. */
export function definitionHash(query: {
  sql_text?: string | null
  freshness_sources?: string | null
}): string {
  return createHash('sha1')
    .update(`${query.sql_text ?? ''}|${query.freshness_sources ?? ''}`)
    .digest('hex')
    .slice(0, 12)
}

/**
 * The registered collections a custom query reads, for the live "data changed since run" chip.
 * Declared `freshness_sources` win; else inferred from the SQL and the procedures it EXECs.
 * Computed once per query DEFINITION (memoized by id + definition hash, so an edited query
 * re-infers and a run never does) and needs no timestamp column and no probe, so it serves
 * uncached queries too. Tables that are not registered collections are left out: no live
 * event can ever name them. Shaped like freshness facts without a clock.
 */
export async function liveReadSources(query: {
  id: unknown
  sql_text?: string | null
  freshness_sources?: string | null
}): Promise<Array<{ table: string; column: string; changed_at: null }>> {
  const key = `${String(query.id)}:${definitionHash(query)}`
  let hit = liveInferred.get(key)
  if (!hit || Date.now() - hit.at >= LIVE_TTL) {
    const value = (async () => {
      const declared = parseFreshnessSources(query.freshness_sources)
      if (declared?.length) return declared.map((s) => s.table)
      return tablesReadBy(query.sql_text ?? '')
    })().catch(() => [] as string[])
    hit = { at: Date.now(), value }
    if (liveInferred.size > 500) liveInferred.clear()
    liveInferred.set(key, hit)
  }
  const tables = await hit.value
  const registry = await registeredCollections()
  const out: Array<{ table: string; column: string; changed_at: null }> = []
  for (const t of tables) {
    const name = registry.get(t.toLowerCase())
    if (name && !out.some((o) => o.table === name))
      out.push({ table: name, column: '', changed_at: null })
  }
  return out.slice(0, MAX_SOURCES)
}

/** Test seam: forget memoized definitions and the collection registry. */
export function __resetLiveSources(): void {
  liveInferred.clear()
  collectionNames = null
}
