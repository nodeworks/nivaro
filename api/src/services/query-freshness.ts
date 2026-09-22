import { db } from '../db/index.js'

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
 */

export interface FreshnessSource {
  table: string
  column: string
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
    if (IDENT.test(t) && IDENT.test(c)) out.push({ table: t, column: c })
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
      const rows = (await db('information_schema.columns')
        .whereIn('column_name', TIMESTAMP_COLUMNS)
        .whereIn('data_type', ['datetime', 'datetime2', 'date', 'smalldatetime', 'datetimeoffset'])
        .select('table_name', 'column_name')) as Array<{ table_name: string; column_name: string }>
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

const TABLE_REF = /\b(?:from|join|into|update)\s+\[?(?:dbo\]?\.\[?)?([A-Za-z_][A-Za-z0-9_]*)\]?/gi
const EXEC_REF = /\bexec(?:ute)?\s+\[?(?:dbo\]?\.\[?)?([A-Za-z_][A-Za-z0-9_]*)\]?/gi
const SKIP = /^(nivaro_|sys|information_schema|staging_|zz_|temp_|#)/i

function tablesIn(sql: string): Set<string> {
  const out = new Set<string>()
  for (const m of sql.matchAll(TABLE_REF)) out.add(m[1].toLowerCase())
  return out
}

async function procedureText(name: string): Promise<string | null> {
  if (!IDENT.test(name)) return null
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
  const key = `${src.table}.${src.column}`
  const hit = newest.get(key)
  if (hit && Date.now() - hit.at < NEWEST_TTL) return hit.value
  const value = (async () => {
    try {
      const row = (await db(src.table).max(`${src.column} as v`).first()) as
        | { v: unknown }
        | undefined
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
