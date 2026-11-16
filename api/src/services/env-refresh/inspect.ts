/**
 * Environment refresh — gathers the dry-run plan's facts. SELECTs only, against the source and
 * target by cross-database name, through whatever `SqlRunner` the caller holds (the API's pool
 * for the console's plan, the host runner's own connection for its dry run). Nothing here writes.
 */
import type { EnvRefreshDecl } from '@nivaro/extension-kit'
import type { ResolvedDirection } from './directions.js'
import { captureKeepSet, qcat, qtable, type SavedKeepSet, type SqlRunner } from './keep-set.js'
import { buildRefreshPlan, judgePreflight, type PreflightFacts, type RefreshPlan } from './plan.js'
import { type EnvKeepEntry, keepsForTarget } from './registry.js'
import { runSafetyPass } from './safety.js'

export const DEFAULT_BACKUP_DIR = 'F:\\SQLBackups'

const num = (v: unknown): number | null => {
  const n = Number(v)
  return v == null || !Number.isFinite(n) ? null : n
}

async function soft<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function ledger(sql: SqlRunner, db: string): Promise<string[]> {
  return soft(
    async () =>
      (await sql.raw(`SELECT name FROM ${qtable(db, 'nivaro_migrations')} ORDER BY name`)).map(
        (r) => String(r.name)
      ),
    []
  )
}

/** The longest volume mount point that prefixes `path` (case-insensitive), with its free MB. */
export function volumeFor(
  path: string,
  volumes: Array<{ vol: string; free_mb: number }>
): { vol: string; free_mb: number } | null {
  const p = path.toLowerCase()
  let best: { vol: string; free_mb: number } | null = null
  for (const v of volumes)
    if (p.startsWith(v.vol.toLowerCase()) && (!best || v.vol.length > best.vol.length)) best = v
  return best
}

export async function gatherFacts(
  sql: SqlRunner,
  o: { sourceDb: string; targetDb: string; backupDir: string; busy: string | null }
): Promise<PreflightFacts & { tables: number; rows: number }> {
  const states = await soft(
    () =>
      sql.raw('SELECT name, state_desc FROM sys.databases WHERE name IN (?, ?)', [
        o.sourceDb,
        o.targetDb
      ]),
    [] as Array<Record<string, unknown>>
  )
  const online = (db: string) =>
    states.some(
      (r) => String(r.name).toLowerCase() === db.toLowerCase() && r.state_desc === 'ONLINE'
    )
  const used = (db: string) =>
    soft(
      async () =>
        num(
          (
            await sql.raw(
              `SELECT SUM(used_page_count) * 8 / 1024 AS mb FROM ${qcat(db)}.sys.dm_db_partition_stats`
            )
          )[0]?.mb
        ),
      null
    )
  const allocated = (db: string) =>
    soft(
      async () =>
        num(
          (
            await sql.raw(
              'SELECT SUM(CAST(size AS bigint)) * 8 / 1024 AS mb FROM sys.master_files WHERE database_id = DB_ID(?)',
              [db]
            )
          )[0]?.mb
        ),
      null
    )
  const volumes = await soft(
    async () =>
      (
        await sql.raw(
          `SELECT DISTINCT vs.volume_mount_point AS vol, vs.available_bytes / 1048576 AS free_mb
             FROM sys.master_files mf CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs`
        )
      ).map((r) => ({ vol: String(r.vol), free_mb: Number(r.free_mb) })),
    [] as Array<{ vol: string; free_mb: number }>
  )
  const dataFiles = await soft(
    async () =>
      (
        await sql.raw(
          "SELECT physical_name FROM sys.master_files WHERE database_id = DB_ID(?) AND type_desc = 'ROWS'",
          [o.targetDb]
        )
      ).map((r) => String(r.physical_name)),
    [] as string[]
  )
  const dataVols = dataFiles.map((f) => volumeFor(f, volumes)).filter((v) => v != null)
  const lastBackup = await soft(
    async () =>
      num(
        (
          await sql.raw(
            // The newest COMPRESSED full backup (what this run takes); an uncompressed one (a
            // backup agent's) says nothing about the size of ours.
            `SELECT TOP 1 compressed_backup_size / 1048576 AS mb FROM msdb.dbo.backupset
              WHERE database_name = ? AND type = 'D' AND compressed_backup_size < backup_size * 0.8
              ORDER BY backup_finish_date DESC`,
            [o.sourceDb]
          )
        )[0]?.mb
      ),
    null
  )
  const counts = await soft(
    async () =>
      (
        await sql.raw(
          `SELECT COUNT(DISTINCT t.object_id) AS tables,
                  SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS rows
             FROM ${qcat(o.sourceDb)}.sys.tables t
             JOIN ${qcat(o.sourceDb)}.sys.dm_db_partition_stats p ON p.object_id = t.object_id`
        )
      )[0] ?? {},
    {} as Record<string, unknown>
  )
  const backupVol = volumeFor(o.backupDir, volumes)
  return {
    sourceOnline: online(o.sourceDb),
    targetOnline: online(o.targetDb),
    sourceLedger: await ledger(sql, o.sourceDb),
    targetLedger: await ledger(sql, o.targetDb),
    sourceUsedMb: await used(o.sourceDb),
    targetUsedMb: await used(o.targetDb),
    sourceAllocatedMb: await allocated(o.sourceDb),
    targetAllocatedMb: await allocated(o.targetDb),
    backupFreeMb: backupVol ? backupVol.free_mb : null,
    dataFreeMb: dataVols.length ? Math.min(...dataVols.map((v) => v!.free_mb)) : null,
    lastSourceBackupMb: lastBackup,
    busy: o.busy,
    tables: Number(counts.tables ?? 0),
    rows: Number(counts.rows ?? 0)
  }
}

/** The whole dry-run plan for a direction. Read-only. */
export async function buildPlanFromDatabases(
  sql: SqlRunner,
  o: {
    decl: EnvRefreshDecl
    dir: ResolvedDirection
    entries: EnvKeepEntry[]
    busy: string | null
    filesFallback: string | null
    /** The host runner reads every kept row whole; the console samples big tables. */
    sampleOver?: number
  }
): Promise<{ plan: RefreshPlan; captured: SavedKeepSet }> {
  const entries = keepsForTarget(o.entries, o.dir.target)
  const facts = await gatherFacts(sql, {
    sourceDb: o.dir.source.database,
    targetDb: o.dir.target.database,
    backupDir: o.decl.backup_dir ?? DEFAULT_BACKUP_DIR,
    busy: o.busy
  })
  const captured = await captureKeepSet(sql, {
    entries,
    direction: o.dir.key,
    sourceDb: o.dir.source.database,
    targetDb: o.dir.target.database,
    sampleOver: o.sampleOver
  })
  const safety = await runSafetyPass(sql, {
    readDb: o.dir.source.database,
    writeDb: o.dir.target.database,
    instanceKey: o.dir.target.instance_key ?? null,
    saved: captured,
    dry: true
  })
  const plan = buildRefreshPlan({
    direction: o.dir.key,
    source: o.dir.source,
    target: o.dir.target,
    entries,
    captured,
    safety,
    preflight: judgePreflight(facts),
    sourceTables: { tables: facts.tables, rows: facts.rows, used_mb: facts.sourceUsedMb },
    filesFallback: o.filesFallback,
    rollbackHours: o.decl.rollback_hours ?? 24
  })
  return { plan, captured }
}
