import { db } from '../db/index.js'
import { liveFilterColumns } from './traffic-taps/read-shapes.js'

/**
 * Index advisor. The hot filter columns are already declared in config —
 * M2O FKs (nivaro_relations), queue source filters, RLS row filters,
 * workflow state mirrors — so instead of guessing from query text, cross
 * those candidates against sys.index_columns leading-column coverage on
 * tables big enough to care about. Each suggestion ships its CREATE INDEX,
 * appliable in one click (the nivaro_policies index win, systematized).
 * GET /api/index-advisor serves it; the database-tuning index observer reads it too.
 */

const IDENT = /^[A-Za-z0-9_]+$/

export interface Suggestion {
  table: string
  column: string
  rows: number
  reasons: string[]
  create_sql: string
  /** Traffic Map evidence (#1135): reads on this process that filtered / sorted by the column
   *  in the last 15 minutes. Absent when none did. */
  live?: { filter: number; sort: number; ops: string[] }
}

export const MIN_ROWS = 50_000

export function indexName(table: string, column: string): string {
  return `idx_${table}_${column.replace(/,/g, '_')}`.slice(0, 120)
}

export function createIndexSql(table: string, column: string): string {
  const cols = column
    .split(',')
    .map((c) => `[${c}]`)
    .join(', ')
  return `CREATE NONCLUSTERED INDEX ${indexName(table, column)} ON [${table}] (${cols})`
}

export async function indexAdvisorSuggestions(): Promise<{
  suggestions: Suggestion[]
  min_rows: number
}> {
  // Row counts in one partition-stats query (86 serial COUNT(*)s took 3.2s
  // at this RTT — the config-diff lesson).
  const counts = (await db.raw(`
    SELECT t.name AS table_name, SUM(p.row_count) AS rows
    FROM sys.tables t
    JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    GROUP BY t.name
  `)) as Array<{ table_name: string; rows: number }>
  const rowCount = new Map(counts.map((c) => [c.table_name.toLowerCase(), Number(c.rows)]))

  // Existing leading index columns per table.
  const idx = (await db.raw(`
    SELECT t.name AS table_name, c.name AS column_name
    FROM sys.index_columns ic
    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    JOIN sys.tables t ON t.object_id = ic.object_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.key_ordinal = 1
  `)) as Array<{ table_name: string; column_name: string }>
  const indexed = new Set(idx.map((r) => `${r.table_name}.${r.column_name}`.toLowerCase()))

  const physicalCols = (await db('information_schema.columns').select(
    'table_name',
    'column_name'
  )) as Array<{ table_name: string; column_name: string }>
  const colExists = new Set(
    physicalCols.map((r) => `${r.table_name}.${r.column_name}`.toLowerCase())
  )

  // Candidate columns with the config source that makes them hot.
  const candidates = new Map<string, Set<string>>() // table.column -> reasons
  const add = (table: unknown, column: unknown, reason: string) => {
    const t = String(table ?? '').trim()
    const c = String(column ?? '').trim()
    if (!IDENT.test(t) || !IDENT.test(c) || /^nivaro_/i.test(t)) return
    const key = `${t}.${c}`.toLowerCase()
    if (!colExists.has(key)) return
    const set = candidates.get(key) ?? new Set<string>()
    set.add(reason)
    candidates.set(key, set)
  }

  const rels = (await db('nivaro_relations')
    .whereNotNull('many_collection')
    .whereNotNull('many_field')
    .select('many_collection', 'many_field')) as Array<{
    many_collection: string
    many_field: string
  }>
  for (const r of rels)
    add(r.many_collection, r.many_field, 'M2O foreign key (joins + relation filters)')

  const sources = (await db('nivaro_queue_sources')
    .whereNotNull('filters')
    .select('collection', 'filters')) as Array<{
    collection: string | null
    filters: string | null
  }>
  for (const srow of sources) {
    if (!srow.collection) continue
    try {
      for (const f of JSON.parse(srow.filters ?? '[]') as Array<{ field?: string }>) {
        if (f?.field && !f.field.includes('.')) add(srow.collection, f.field, 'queue source filter')
      }
    } catch {
      // unparseable filter config — skip
    }
  }

  const policies = (await db('nivaro_policies')
    .whereNotNull('row_filter')
    .select('collection', 'row_filter')) as Array<{
    collection: string
    row_filter: string | null
  }>
  for (const p of policies) {
    try {
      const rf = JSON.parse(p.row_filter ?? '{}') as Record<string, unknown>
      for (const key of Object.keys(rf)) {
        if (!key.startsWith('_') && !key.includes('.'))
          add(p.collection, key, 'row-level security filter')
      }
    } catch {
      // skip
    }
  }

  const bindings = (await db('nivaro_workflow_bindings')
    .whereNotNull('state_field')
    .select('collection', 'state_field')) as Array<{ collection: string; state_field: string }>
  for (const b of bindings)
    add(b.collection, b.state_field, 'workflow state mirror (state filters)')

  // #1135 — live evidence: what callers actually filtered and sorted by on this process in
  // the last 15 minutes (Traffic Map read shapes; empty in cloud mode or when idle).
  const live = new Map<string, { filter: number; sort: number; ops: string[] }>()
  for (const l of liveFilterColumns(900)) {
    const key = `${l.collection}.${l.column}`.toLowerCase()
    live.set(key, { filter: l.filter, sort: l.sort, ops: l.ops })
    const how = [l.filter ? `filtered ${l.filter}×` : '', l.sort ? `sorted ${l.sort}×` : '']
      .filter(Boolean)
      .join(', ')
    add(l.collection, l.column, `live reads: ${how} in the last 15 min`)
  }

  // #475 — the (collection, item) pair. Every correlated "which instance /
  // state / revision does this record have" lookup filters on both columns;
  // nivaro_workflow_instances carried only its PK and scanned 115k rows per
  // check (16.4s → 1.5s on the project-360 hub once migration 331 added
  // the pair). Any table with both columns and no index LEADING on the pair
  // — in either order — is the same shape waiting to be found.
  const pairTables = (await db.raw(`
    SELECT t.name AS table_name, c2.name AS item_col
    FROM sys.tables t
    JOIN sys.columns c1 ON c1.object_id = t.object_id AND c1.name = 'collection'
    JOIN sys.columns c2 ON c2.object_id = t.object_id AND c2.name IN ('item', 'item_id')
  `)) as Array<{ table_name: string; item_col: string }>
  const leadingPairs = (await db.raw(`
    SELECT t.name AS table_name, c1.name AS k1, c2.name AS k2
    FROM sys.indexes i
    JOIN sys.tables t ON t.object_id = i.object_id
    JOIN sys.index_columns ic1 ON ic1.object_id = i.object_id AND ic1.index_id = i.index_id AND ic1.key_ordinal = 1
    JOIN sys.columns c1 ON c1.object_id = ic1.object_id AND c1.column_id = ic1.column_id
    JOIN sys.index_columns ic2 ON ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.key_ordinal = 2
    JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
    WHERE i.index_id > 0
  `)) as Array<{ table_name: string; k1: string; k2: string }>
  const pairIndexed = new Set(
    leadingPairs.map((r) => `${r.table_name}.${r.k1},${r.k2}`.toLowerCase())
  )
  const pairSuggestions: Suggestion[] = []
  for (const pt of pairTables) {
    const table = pt.table_name
    const rows = rowCount.get(table.toLowerCase()) ?? 0
    if (rows < MIN_ROWS) continue
    const a = `${table}.collection,${pt.item_col}`.toLowerCase()
    const b = `${table}.${pt.item_col},collection`.toLowerCase()
    if (pairIndexed.has(a) || pairIndexed.has(b)) continue
    const column = `collection,${pt.item_col}`
    pairSuggestions.push({
      table,
      column,
      rows,
      reasons: [
        `correlated (collection, ${pt.item_col}) record lookup — no index leads on the pair`
      ],
      create_sql: createIndexSql(table, column)
    })
  }

  const suggestions: Suggestion[] = [...pairSuggestions]
  for (const [key, reasons] of candidates) {
    const [table, column] = key.split('.')
    const rows = rowCount.get(table) ?? 0
    if (rows < MIN_ROWS) continue
    if (indexed.has(key)) continue
    suggestions.push({
      table,
      column,
      rows,
      reasons: [...reasons],
      create_sql: createIndexSql(table, column),
      ...(live.has(key) ? { live: live.get(key) } : {})
    })
  }
  // Live evidence first (a column callers use right now), then by table size.
  const liveN = (s: Suggestion) => (s.live ? s.live.filter + s.live.sort : 0)
  suggestions.sort((a, z) => liveN(z) - liveN(a) || z.rows - a.rows)
  return { suggestions, min_rows: MIN_ROWS }
}
