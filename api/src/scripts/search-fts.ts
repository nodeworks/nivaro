/**
 * Full-text indexes for search (search item 24). Run through `node scripts/search-fts.mjs`.
 *
 *   node scripts/search-fts.mjs --plan [--min-rows 10000] [--all]
 *       Read-only. Lists registered collections with long text columns that a
 *       contains-LIKE has to read row by row, with row counts, the key index a
 *       full-text index would use and what is indexed already.
 *
 *   node scripts/search-fts.mjs --execute --table workflows --columns name,objective
 *       Prints the DDL it would run and STOPS. Add --yes to run it.
 *
 *   node scripts/search-fts.mjs --drop --table workflows [--yes]
 *       The rollback: drops the table's full-text index (catalog kept).
 *
 * Nothing at boot or in a migration ever creates these: an index is the DBA's
 * call. Production is a replication publisher — full-text DDL there goes to
 * the DBA first. The search reads indexes through services/search-fts.ts
 * (catalog re-read every 5 minutes per tenant) and falls back to LIKE where
 * none exists, so an index can be added or dropped at any time.
 */
import { db } from '../db/index.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const CATALOG = 'nivaro_search'

const DBA_NOTES = `
DBA notes
  • Production is a replication PUBLISHER: run full-text DDL there only with the DBA.
    Full-text indexes are not replicated by default; subscribers keep LIKE.
  • CREATE FULLTEXT INDEX returns at once; the first population runs in the
    background (sys.fulltext_indexes.has_crawl_completed). Nivaro ignores an index
    until its first crawl has finished.
  • CHANGE_TRACKING AUTO keeps it current asynchronously: a row saved a moment ago
    may not be found for a few seconds.
  • Full-text DDL cannot run inside a transaction and needs ALTER on the table plus
    CREATE FULLTEXT CATALOG on the database (db_ddladmin).
  • The full-text feature must be installed on the instance
    (FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') = 1).
  • Matching changes: CONTAINS finds word STARTS ("budg" → "budget"), not any substring
    ("123" does not find "ABC123"). Index long prose columns, keep id-like columns on LIKE.
  • Rollback: node scripts/search-fts.mjs --drop --table <table> --yes
`

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const has = (name: string) => process.argv.includes(name)

function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : []) as T[]
}

async function ftsInstalled(): Promise<boolean> {
  const r = rowsOf<{ on: number }>(
    await db.raw(`SELECT CAST(FULLTEXTSERVICEPROPERTY('IsFullTextInstalled') AS int) AS [on]`)
  )
  return Number(r[0]?.on) === 1
}

/** The single-column, unique, non-null index a full-text index needs as its KEY INDEX. */
async function keyIndex(table: string): Promise<string | null> {
  const r = rowsOf<{ name: string }>(
    await db.raw(
      `SELECT TOP 1 i.name
       FROM sys.indexes i
       JOIN sys.tables t ON t.object_id = i.object_id
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE t.name = ? AND SCHEMA_NAME(t.schema_id) = 'dbo' AND i.is_unique = 1
         AND i.is_disabled = 0 AND i.has_filter = 0 AND c.is_nullable = 0
       GROUP BY i.name, i.is_primary_key
       HAVING COUNT(*) = 1
       ORDER BY i.is_primary_key DESC`,
      [table]
    )
  )
  return r[0]?.name ?? null
}

async function indexedColumns(table: string): Promise<string[]> {
  return rowsOf<{ name: string }>(
    await db.raw(
      `SELECT c.name
       FROM sys.fulltext_index_columns fic
       JOIN sys.tables t ON t.object_id = fic.object_id
       JOIN sys.columns c ON c.object_id = fic.object_id AND c.column_id = fic.column_id
       WHERE t.name = ? AND SCHEMA_NAME(t.schema_id) = 'dbo'`,
      [table]
    )
  ).map((r) => r.name)
}

async function plan(): Promise<void> {
  const minRows = Math.max(0, Number(arg('--min-rows') ?? 10_000) || 0)
  const installed = await ftsInstalled().catch(() => false)
  const collections = new Set(
    rowsOf<{ collection: string }>(await db('nivaro_collections').select('collection'))
      .map((r) => r.collection)
      .filter((c) => !/^nivaro_|^directus_/i.test(c))
  )
  // Long text = nvarchar/varchar(max) or 200+ characters: the columns a LIKE pays for.
  const cols = rowsOf<{ table_name: string; column_name: string; len: number }>(
    await db.raw(
      `SELECT t.name AS table_name, c.name AS column_name, c.max_length AS len
       FROM sys.columns c
       JOIN sys.tables t ON t.object_id = c.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
         AND ty.name IN ('nvarchar', 'varchar', 'nchar', 'char', 'ntext', 'text')
         AND (c.max_length = -1 OR (ty.name LIKE 'n%' AND c.max_length >= 400)
              OR (ty.name NOT LIKE 'n%' AND c.max_length >= 200))`
    )
  )
  const rowCounts = new Map(
    rowsOf<{ table_name: string; row_count: number | string }>(
      await db.raw(
        `SELECT tb.name AS table_name, SUM(p.rows) AS row_count
         FROM sys.partitions p JOIN sys.tables tb ON tb.object_id = p.object_id
         WHERE p.index_id IN (0, 1) GROUP BY tb.name`
      )
    ).map((r) => [r.table_name, Number(r.row_count)])
  )
  const byTable = new Map<string, string[]>()
  for (const c of cols) {
    if (!collections.has(c.table_name)) continue
    const list = byTable.get(c.table_name) ?? []
    list.push(`${c.column_name}${c.len === -1 ? ' (max)' : ''}`)
    byTable.set(c.table_name, list)
  }
  const tables = [...byTable.entries()]
    .map(([table, columns]) => ({ table, columns, rows: rowCounts.get(table) ?? 0 }))
    .filter((t) => has('--all') || t.rows >= minRows)
    .sort((a, b) => b.rows - a.rows)

  console.log(`Full-text installed on this server: ${installed ? 'yes' : 'NO'}`)
  console.log(
    `Collections with long text columns${has('--all') ? '' : ` and at least ${minRows.toLocaleString('en-US')} rows`}: ${tables.length}\n`
  )
  for (const t of tables) {
    const [key, indexed] = await Promise.all([
      keyIndex(t.table).catch(() => null),
      installed ? indexedColumns(t.table).catch(() => []) : Promise.resolve([])
    ])
    console.log(`${t.table}  —  ${t.rows.toLocaleString('en-US')} rows`)
    console.log(`  long text: ${t.columns.join(', ')}`)
    console.log(`  key index: ${key ?? 'NONE (needs a unique, non-null, single-column index)'}`)
    if (indexed.length) console.log(`  full-text already: ${indexed.join(', ')}`)
    if (t.rows > 500_000)
      console.log('  note: above the omnisearch row budget (500k) — skipped by Cmd+K today')
    console.log('')
  }
  console.log(
    'Next: node scripts/search-fts.mjs --execute --table <table> --columns a,b  (prints the DDL)'
  )
  console.log(DBA_NOTES)
}

async function execute(): Promise<number> {
  const table = arg('--table') ?? ''
  const columns = (arg('--columns') ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  if (!IDENT.test(table) || columns.length === 0 || !columns.every((c) => IDENT.test(c))) {
    console.error('--execute needs --table <name> and --columns a,b (plain identifiers)')
    return 2
  }
  if (!(await ftsInstalled())) {
    console.error('Full-text search is not installed on this SQL Server instance.')
    return 1
  }
  const existing = rowsOf<{ column_name: string; type: string }>(
    await db.raw(
      `SELECT c.name AS column_name, ty.name AS type
       FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       WHERE t.name = ? AND SCHEMA_NAME(t.schema_id) = 'dbo'`,
      [table]
    )
  )
  if (existing.length === 0) {
    console.error(`No table dbo.${table}.`)
    return 1
  }
  for (const c of columns) {
    const col = existing.find((e) => e.column_name.toLowerCase() === c.toLowerCase())
    if (!col || !/char|text/i.test(col.type)) {
      console.error(`${table}.${c} is not a text column.`)
      return 1
    }
  }
  const key = await keyIndex(table)
  if (!key) {
    console.error(`${table} has no unique, non-null, single-column index to key a full-text index.`)
    return 1
  }
  const already = (await indexedColumns(table)).map((c) => c.toLowerCase())
  const add = columns.filter((c) => !already.includes(c.toLowerCase()))
  const statements: string[] = []
  const catalogs = rowsOf<{ name: string }>(
    await db.raw('SELECT name FROM sys.fulltext_catalogs WHERE name = ?', [CATALOG])
  )
  if (catalogs.length === 0) statements.push(`CREATE FULLTEXT CATALOG [${CATALOG}]`)
  if (already.length === 0) {
    statements.push(
      `CREATE FULLTEXT INDEX ON [dbo].[${table}] (${add.map((c) => `[${c}]`).join(', ')}) KEY INDEX [${key}] ON [${CATALOG}] WITH CHANGE_TRACKING AUTO, STOPLIST = SYSTEM`
    )
  } else if (add.length > 0) {
    statements.push(
      `ALTER FULLTEXT INDEX ON [dbo].[${table}] ADD (${add.map((c) => `[${c}]`).join(', ')})`
    )
  }
  if (statements.length === 0) {
    console.log(`dbo.${table} already has a full-text index on ${columns.join(', ')}.`)
    return 0
  }
  const where = rowsOf<{ db: string; host: string }>(
    await db.raw('SELECT DB_NAME() AS db, @@SERVERNAME AS host')
  )[0]
  console.log(`Database: ${where?.db ?? '?'} on ${where?.host ?? '?'}`)
  console.log('DDL:')
  for (const s of statements) console.log(`  ${s};`)
  console.log(DBA_NOTES)
  if (!has('--yes')) {
    console.log('Not run. Add --yes to run it (after the DBA has agreed, on production).')
    return 0
  }
  // Full-text DDL cannot run in a transaction: one statement at a time.
  for (const s of statements) await db.raw(s)
  console.log('Done. Population runs in the background; search uses it once the first crawl ends.')
  return 0
}

async function drop(): Promise<number> {
  const table = arg('--table') ?? ''
  if (!IDENT.test(table)) {
    console.error('--drop needs --table <name>')
    return 2
  }
  const sql = `DROP FULLTEXT INDEX ON [dbo].[${table}]`
  console.log(`DDL:\n  ${sql};`)
  if (!has('--yes')) {
    console.log('Not run. Add --yes to run it.')
    return 0
  }
  await db.raw(sql)
  console.log('Dropped. Search falls back to LIKE within 5 minutes (catalog cache).')
  return 0
}

let code = 0
try {
  if (has('--execute')) code = await execute()
  else if (has('--drop')) code = await drop()
  else if (has('--plan')) await plan()
  else {
    console.log(
      'Usage: node scripts/search-fts.mjs --plan [--min-rows N] [--all]\n' +
        '       node scripts/search-fts.mjs --execute --table <t> --columns a,b [--yes]\n' +
        '       node scripts/search-fts.mjs --drop --table <t> [--yes]'
    )
    console.log(DBA_NOTES)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  code = 1
} finally {
  await db.destroy()
}
process.exit(code)
