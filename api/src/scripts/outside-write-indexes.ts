/**
 * Indexes for the outside-write watcher (realtime item 2) on a development database. Run from api/:
 *
 *   CRON_TICKS=off SKIP_BOOT_MIGRATIONS=1 npx tsx src/scripts/outside-write-indexes.ts \
 *     --database EFP_Development --log <file> [--table <t>] [--execute]
 *
 * The watcher refuses a collection whose changed-at column no index starts with (it would read
 * the whole table every few seconds). This creates, for each such collection, one nonclustered
 * index on that column: IX_<table>_<column>_nvr_watch. Guarded: skipped when an index already
 * leads with the column or the name exists; ONLINE = ON where the edition allows it (Enterprise /
 * Developer / Azure); one statement at a time with its own timeout. Without --execute it prints
 * the plan. Refuses any database but the one named by --database. NEVER production: that waits
 * for a release (and the DBA — production is a replication publisher).
 *
 * Rollback: DROP INDEX [IX_<table>_<column>_nvr_watch] ON [dbo].[<table>] (the log lists each).
 */
import { appendFileSync } from 'node:fs'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { watchCatalog } from '../services/outside-write-watch.js'
import { runLongSql } from '../services/run-long.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const arg = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const execute = has('--execute')
const logFile = arg('--log')
const only = arg('--table')?.toLowerCase()
const TIMEOUT_MS = 10 * 60_000

const log = (line: string) => {
  process.stdout.write(`${line}\n`)
  if (logFile) appendFileSync(logFile, `${line}\n`)
}
const q = (s: string) => `[${s.replace(/]/g, ']]')}]`
const lit = (s: string) => `N'${s.replace(/'/g, "''")}'`

/** IX_<table>_<column>_nvr_watch, at most 128 characters (pure). */
export function watchIndexName(table: string, column: string): string {
  const suffix = '_nvr_watch'
  const base = `IX_${table}_${column}`.replace(/[^A-Za-z0-9_]/g, '_')
  return `${base.slice(0, 128 - suffix.length)}${suffix}`
}

async function main(): Promise<number> {
  // The outside-write watcher reads SQL Server change tracking; elsewhere there is nothing to index.
  if (!isMssql(db)) {
    log('# outside-write indexes: this needs a SQL Server database — nothing to do here')
    return 0
  }
  const want = arg('--database')
  if (!want) throw new Error('--database <name> is required (the database this may change)')
  const [{ name: dbName, edition }] = (await db.raw(
    "SELECT DB_NAME() AS name, CAST(SERVERPROPERTY('EngineEdition') AS INT) AS edition"
  )) as Array<{ name: string; edition: number }>
  if (dbName !== want) throw new Error(`Connected to ${dbName}, not ${want}: refusing`)
  const online = [3, 5, 8].includes(Number(edition))
  const catalog = await watchCatalog(true)
  const todo = [...catalog.values()].filter(
    (w) => w.reason_code === 'no-index' && w.schema && w.table && w.ts
  )
  log(
    `# outside-write indexes ${execute ? 'CREATE' : 'PLAN'} on ${dbName} — ${new Date().toISOString()}; ONLINE ${online ? 'on' : 'off (edition)'}; ${todo.length} refused for no index`
  )
  const counts = { created: 0, skipped: 0, failed: 0, planned: 0 }
  for (const w of todo) {
    const schema = w.schema as string
    const table = w.table as string
    const col = w.ts as string
    if (only && table.toLowerCase() !== only) continue
    const name = watchIndexName(table, col)
    const qualified = `${q(schema)}.${q(table)}`
    const [state] = (await db.raw(
      `SELECT
         (SELECT COUNT(*) FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           WHERE i.object_id = OBJECT_ID(${lit(qualified)}) AND ic.key_ordinal = 1
             AND c.name = ${lit(col)} AND i.is_disabled = 0) AS leading,
         (SELECT COUNT(*) FROM sys.indexes WHERE object_id = OBJECT_ID(${lit(qualified)})
             AND name = ${lit(name)}) AS named,
         (SELECT SUM(p.rows) FROM sys.partitions p
           WHERE p.object_id = OBJECT_ID(${lit(qualified)}) AND p.index_id IN (0, 1)) AS row_count`
    )) as Array<{ leading: number; named: number; row_count: number | null }>
    if (Number(state?.leading) > 0 || Number(state?.named) > 0) {
      counts.skipped++
      log(`SKIP    ${qualified}.${col} — an index already leads with it (${name})`)
      continue
    }
    const sql = `CREATE NONCLUSTERED INDEX ${q(name)} ON ${qualified} (${q(col)})${online ? ' WITH (ONLINE = ON)' : ''}`
    if (!execute) {
      counts.planned++
      log(`PLAN    ${sql}  -- ${Number(state?.row_count ?? 0).toLocaleString('en-US')} rows`)
      continue
    }
    const t0 = Date.now()
    try {
      await runLongSql(sql, { timeoutMs: TIMEOUT_MS })
      counts.created++
      log(
        `CREATED ${name} ON ${qualified} (${col}) — ${Number(state?.row_count ?? 0).toLocaleString('en-US')} rows, ${Date.now() - t0} ms`
      )
    } catch (e) {
      counts.failed++
      log(`FAIL    ${sql} — ${e instanceof Error ? e.message : String(e)}`)
      throw new Error('stopped at the first failure')
    }
  }
  log(
    `# done: created ${counts.created}, skipped ${counts.skipped}, failed ${counts.failed}${execute ? '' : `, planned ${counts.planned}`}`
  )
  return 0
}

let code = 0
try {
  code = await main()
} catch (err) {
  log(`# STOPPED: ${err instanceof Error ? err.message : String(err)}`)
  code = 1
} finally {
  await db.destroy()
}
process.exit(code)
