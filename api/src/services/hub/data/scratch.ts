import { tableCountSql } from '../../recovery/drill.js'
import { type FileListRow, planMoves, splitTableRef } from '../../recovery/plan.js'
import type { TableCount } from '../../recovery/smoke.js'
import type { SqlExec } from './env-db.js'
import {
  databaseExistsSql,
  dropDatabaseSql,
  fileListSqlFor,
  isScratchName,
  ledgerSql,
  restoreScratchSql,
  SERVER_FACTS_SQL,
  scratchMarkReadSql,
  scratchMarkSql,
  scratchName
} from './mssql-sql.js'
import { DataError } from './types.js'

/**
 * Scratch copies for restore drills and move rehearsals: a backup file restored under
 * nivaro_hub_scratch_<d|r><run id>, marked with the run id, read (counts, ledger), dropped.
 *
 * Ownership: the name carries the run id, so only that run ever restores under it; a database
 * already under the name is dropped only when it carries this run's mark (a leftover of the same
 * run, resumed), anything else refuses (SCRATCH_TAKEN). The live database is never a target:
 * there is no REPLACE in a scratch restore.
 */

export async function scratchMark(exec: SqlExec, scratch: string): Promise<string | null> {
  try {
    const [r] = await exec(scratchMarkReadSql(scratch))
    return r?.v == null ? null : String(r.v)
  } catch {
    return null
  }
}

async function exists(exec: SqlExec, name: string): Promise<boolean> {
  return (await exec(databaseExistsSql(name))).length > 0
}

/** Restores `file` into `scratch` (its own new files) and marks it. Answers the restore time. */
export async function restoreScratch(
  exec: SqlExec,
  scratch: string,
  file: string,
  runId: number,
  /** The backup carries checksums (every Hub backup does): restore WITH CHECKSUM. */
  checksum = true
): Promise<{ ms: number }> {
  if (!isScratchName(scratch))
    throw new DataError('SCRATCH_TAKEN', `${scratch} is not a scratch name.`)
  if (await exists(exec, scratch)) {
    if ((await scratchMark(exec, scratch)) !== String(runId))
      throw new DataError(
        'SCRATCH_TAKEN',
        `A database named ${scratch} already exists and is not this run’s copy: it was left alone.`
      )
    await exec(dropDatabaseSql(scratch))
  }
  const [facts] = await exec(SERVER_FACTS_SQL)
  const dataPath = String(facts?.data_path ?? '')
  const logPath = String(facts?.log_path ?? dataPath)
  if (!dataPath)
    throw new DataError('BAD_PATH', 'The server names no default data folder for the copy.')
  const files = (await exec(fileListSqlFor(file))) as unknown as FileListRow[]
  const stamp = Date.now().toString(36)
  const moves = planMoves(files, scratch, dataPath, logPath, stamp)
  const t0 = Date.now()
  await exec(restoreScratchSql(scratch, file, moves, checksum))
  const ms = Date.now() - t0
  await exec(scratchMarkSql(scratch, runId))
  return { ms }
}

/** Drops this run's scratch copy; a database under the name that is not this run's stays. */
export async function dropScratch(
  exec: SqlExec,
  scratch: string,
  runId: number
): Promise<'dropped' | 'absent' | 'not_ours'> {
  if (scratch !== scratchName('d', runId) && scratch !== scratchName('r', runId)) return 'not_ours'
  if (!(await exists(exec, scratch))) return 'absent'
  const mark = await scratchMark(exec, scratch)
  // No mark: the restore of this run stopped before the mark (a half-restored copy under this
  // run's own name, which nobody else uses). Another run's mark: never ours.
  if (mark !== null && mark !== String(runId)) return 'not_ours'
  await exec(dropDatabaseSql(scratch))
  return 'dropped'
}

/** Row counts of `refs` in `database` (sys.partitions). */
export async function countTables(
  exec: SqlExec,
  database: string,
  refs: string[]
): Promise<TableCount[]> {
  const rows = await exec(tableCountSql(database, refs))
  const found = new Map(rows.map((r) => [`${r.sch}.${r.tbl}`.toLowerCase(), Number(r.n)]))
  return refs.map((ref) => {
    const { schema, table } = splitTableRef(ref)
    const n = found.get(`${schema}.${table}`.toLowerCase())
    return { ref, exists: n !== undefined, rows: n ?? null }
  })
}

export async function ledgerOf(
  exec: SqlExec,
  database: string
): Promise<{ count: number; latest: string | null } | null> {
  try {
    const [r] = await exec(ledgerSql(database))
    return { count: Number(r?.n ?? 0), latest: r?.latest == null ? null : String(r.latest) }
  } catch {
    return null
  }
}
