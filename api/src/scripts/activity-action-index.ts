import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import {
  ACTION_INDEX,
  ACTIVITY_TABLE,
  createActionIndexSql,
  dropActionIndexSql,
  estimateBuildSeconds,
  supportsOnlineBuild
} from '../services/activity-action-index.js'
import { runLongSql } from '../services/run-long.js'

// ─── nivaro_activity (action, timestamp DESC, id DESC) — off-hours index build ────────────
//
// Why a script and not a migration: services/activity-action-index.ts. On SQL Server
// Standard the build is OFFLINE — every write to nivaro_activity (every item save) waits for
// it — so run it in a quiet window, against the database in .env (or DB_DATABASE=…).
//
//   pnpm --filter @nivaro/api run index:activity-action                  dry run: size, state, DDL
//   pnpm --filter @nivaro/api run index:activity-action -- --execute     build it
//   pnpm --filter @nivaro/api run index:activity-action -- --drop --execute   remove it
//
// --lock-timeout-ms <n> (default 10000): how long the build may wait for its table lock before
// giving up (an offline build waiting for a long reader queues every later write behind it).
// Enterprise / Azure SQL builds ONLINE (writes keep going). Other dialects: nothing to do.

const has = (name: string) => process.argv.includes(name)
function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<number> {
  const execute = has('--execute')
  const drop = has('--drop')
  const lockTimeoutMs = Number(arg('--lock-timeout-ms') ?? 10_000)
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) {
    console.error('--lock-timeout-ms must be a number of milliseconds')
    return 2
  }
  if (!isMssql(db)) {
    console.log(`${ACTION_INDEX} is a SQL Server index; this database needs nothing.`)
    return 0
  }

  const [info] = (await db.raw(
    `SELECT DB_NAME() AS db,
            CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
            CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
            (SELECT SUM(row_count) FROM sys.dm_db_partition_stats
              WHERE object_id = OBJECT_ID(?) AND index_id IN (0, 1)) AS row_count,
            (SELECT COUNT(*) FROM sys.indexes WHERE object_id = OBJECT_ID(?) AND name = ?) AS present`,
    [ACTIVITY_TABLE, ACTIVITY_TABLE, ACTION_INDEX]
  )) as Array<{
    db: string
    engine_edition: number
    edition: string
    row_count: number | string | null
    present: number
  }>
  const rows = Number(info?.row_count ?? 0)
  const present = Number(info?.present ?? 0) > 0
  const online = supportsOnlineBuild(Number(info?.engine_edition))
  const est = estimateBuildSeconds(rows)
  console.log(`database   ${info?.db} (${info?.edition})`)
  console.log(`table      ${ACTIVITY_TABLE}: ${rows.toLocaleString('en-US')} rows`)
  console.log(`index      ${ACTION_INDEX}: ${present ? 'present' : 'missing'}`)

  if (drop) {
    const sql = dropActionIndexSql()
    console.log(`\n${sql}\n`)
    if (!execute) {
      console.log('Dry run — add --execute to drop it.')
      return 0
    }
    if (!present) {
      console.log('Nothing to drop.')
      return 0
    }
    await runLongSql(sql, { timeoutMs: 10 * 60_000 })
    console.log('Dropped.')
    return 0
  }

  const sql = createActionIndexSql({ online, lockTimeoutMs })
  console.log(
    online
      ? 'build      ONLINE (this edition keeps writes going during the build)'
      : `build      OFFLINE — writes to ${ACTIVITY_TABLE} wait for the whole build (est. ${est.low}–${est.high} s at this size)`
  )
  console.log(`\n${sql}\n`)
  if (present) {
    console.log('Already present — nothing to do.')
    return 0
  }
  if (!execute) {
    console.log('Dry run — add --execute to build it (off-hours on a busy instance).')
    return 0
  }
  const started = Date.now()
  await runLongSql(sql, { timeoutMs: 60 * 60_000 })
  const [after] = (await db.raw(
    'SELECT COUNT(*) AS present FROM sys.indexes WHERE object_id = OBJECT_ID(?) AND name = ?',
    [ACTIVITY_TABLE, ACTION_INDEX]
  )) as Array<{ present: number }>
  if (!Number(after?.present)) {
    console.error('The build did not leave the index behind (lock timeout?). Try again later.')
    return 1
  }
  console.log(`Built in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
  return 0
}

let code = 1
try {
  code = await main()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  code = 1
}
await db.destroy()
process.exit(code)
