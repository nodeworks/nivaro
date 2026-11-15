/**
 * SQL Server change tracking for the outside-write watcher (realtime). Run from api/, connected
 * to the database it changes (DB_DATABASE in the environment wins over .env):
 *
 *   CRON_TICKS=off SKIP_BOOT_MIGRATIONS=1 [DB_DATABASE=<db>] npx tsx \
 *     src/scripts/change-tracking-setup.ts --database <db> --log <file> [--execute]
 *
 * Plans by default; --execute changes the database:
 *   1. ALTER DATABASE [<db>] SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON)
 *      when it is not on yet;
 *   2. ALTER TABLE [dbo].[<t>] ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF) for every
 *      registered, non-system, non-virtual collection that is a base table with a primary key and
 *      is not tracked yet — one at a time, each with its own timeout, each logged.
 * Stops at the first unexpected failure. Refuses any database but the one named by --database
 * (and the connected one must be it), and refuses `EFP` (production) outright: production waits
 * for the DBA (it is a replication publisher).
 *
 * Undo (also written to the log): ALTER TABLE [dbo].[<t>] DISABLE CHANGE_TRACKING for each table,
 * then ALTER DATABASE [<db>] SET CHANGE_TRACKING = OFF.
 */
import { appendFileSync } from 'node:fs'
import { db } from '../db/index.js'
import { runLongSql } from '../services/run-long.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const arg = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const execute = has('--execute')
const logFile = arg('--log')
const PRODUCTION = new Set(['efp'])
const TABLE_TIMEOUT_MS = 5 * 60_000

const log = (line: string) => {
  process.stdout.write(`${line}\n`)
  if (logFile) appendFileSync(logFile, `${line}\n`)
}
const q = (s: string) => `[${s.replace(/]/g, ']]')}]`
const SYSTEM = /^(nivaro_|directus_|sysdiagrams$)/i

export interface TablePlan {
  collection: string
  action: 'enable' | 'skip'
  reason?: 'not-table' | 'no-pk' | 'tracked'
}

/** What to do with each registered collection (pure). */
export function planTables(
  collections: string[],
  tables: Map<string, { pk: boolean; tracked: boolean }>
): TablePlan[] {
  const seen = new Set<string>()
  const out: TablePlan[] = []
  for (const c of collections) {
    const k = c.toLowerCase()
    if (!c || SYSTEM.test(c) || seen.has(k)) continue
    seen.add(k)
    const t = tables.get(k)
    if (!t) out.push({ collection: c, action: 'skip', reason: 'not-table' })
    else if (t.tracked) out.push({ collection: c, action: 'skip', reason: 'tracked' })
    else if (!t.pk) out.push({ collection: c, action: 'skip', reason: 'no-pk' })
    else out.push({ collection: c, action: 'enable' })
  }
  return out
}

async function main(): Promise<number> {
  const want = arg('--database')
  if (!want) throw new Error('--database <name> is required (the database this may change)')
  if (PRODUCTION.has(want.toLowerCase()))
    throw new Error(`${want} is production: change tracking there waits for the DBA. Refusing.`)
  const [{ name: dbName }] = (await db.raw('SELECT DB_NAME() AS name')) as Array<{ name: string }>
  if (dbName !== want)
    throw new Error(`Connected to ${dbName}, not ${want}: refusing (set DB_DATABASE=${want})`)
  if (PRODUCTION.has(String(dbName).toLowerCase())) throw new Error('Connected to production.')

  const [ctDb] = (await db.raw(
    `SELECT retention_period AS period, retention_period_units_desc AS units,
            CAST(is_auto_cleanup_on AS INT) AS cleanup
       FROM sys.change_tracking_databases WHERE database_id = DB_ID()`
  )) as Array<{ period: number; units: string; cleanup: number }>
  const collections = (
    (await db('nivaro_collections')
      .distinct('collection')
      .where((w) => w.whereNull('is_virtual').orWhere('is_virtual', false))) as Array<{
      collection: string | null
    }>
  )
    .map((r) => r.collection)
    .filter((c): c is string => !!c)
    .sort()
  const rows = (await db.raw(
    `SELECT t.name AS tbl,
            CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i
                               WHERE i.object_id = t.object_id AND i.is_primary_key = 1)
                 THEN 1 ELSE 0 END AS pk,
            CASE WHEN ct.object_id IS NULL THEN 0 ELSE 1 END AS tracked
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.change_tracking_tables ct ON ct.object_id = t.object_id
      WHERE s.name = 'dbo' AND t.is_ms_shipped = 0`
  )) as Array<{ tbl: string; pk: number; tracked: number }>
  const tables = new Map(
    rows.map((r) => [
      r.tbl.toLowerCase(),
      { pk: Number(r.pk) === 1, tracked: Number(r.tracked) === 1 }
    ])
  )
  const plan = planTables(collections, tables)

  log(`# change tracking ${execute ? 'SETUP' : 'PLAN'} on ${dbName} — ${new Date().toISOString()}`)
  const dbSql = `ALTER DATABASE ${q(dbName)} SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON)`
  if (ctDb) {
    log(
      `DB      already on (retention ${ctDb.period} ${String(ctDb.units).toLowerCase()}, auto cleanup ${ctDb.cleanup ? 'on' : 'off'})`
    )
  } else if (!execute) log(`PLAN    ${dbSql}`)
  else {
    await runLongSql(dbSql, { timeoutMs: TABLE_TIMEOUT_MS })
    log(`DB      ${dbSql}`)
  }

  const counts = { enabled: 0, planned: 0, tracked: 0, 'no-pk': 0, 'not-table': 0, failed: 0 }
  const enabled: string[] = []
  for (const p of plan) {
    if (p.action === 'skip') {
      counts[p.reason as 'tracked' | 'no-pk' | 'not-table']++
      log(
        `SKIP    ${p.collection} — ${p.reason === 'tracked' ? 'already tracked' : p.reason === 'no-pk' ? 'no primary key' : 'not a base table here'}`
      )
      continue
    }
    const sql = `ALTER TABLE [dbo].${q(p.collection)} ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF)`
    if (!execute) {
      counts.planned++
      log(`PLAN    ${sql}`)
      continue
    }
    const t0 = Date.now()
    try {
      await runLongSql(sql, { timeoutMs: TABLE_TIMEOUT_MS })
    } catch (e) {
      counts.failed++
      log(`FAIL    ${sql} — ${e instanceof Error ? e.message : String(e)}`)
      throw new Error('stopped at the first failure')
    }
    counts.enabled++
    enabled.push(p.collection)
    log(`ENABLED ${p.collection} (${Date.now() - t0} ms)`)
  }
  log(
    `# done on ${dbName}: enabled ${counts.enabled}${execute ? '' : ` (planned ${counts.planned})`}, already tracked ${counts.tracked}, skipped no primary key ${counts['no-pk']}, skipped not a table ${counts['not-table']}, failed ${counts.failed}`
  )
  if (enabled.length) {
    log(`# undo on ${dbName} (tables first, then the database):`)
    for (const t of enabled) log(`#   ALTER TABLE [dbo].${q(t)} DISABLE CHANGE_TRACKING;`)
    log(`#   ALTER DATABASE ${q(dbName)} SET CHANGE_TRACKING = OFF;`)
  }
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
