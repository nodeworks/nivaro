import { rawRows } from '../../../db/raw-rows.js'
import { localToUtc } from '../../recovery/drill.js'
import { openDatabaseConnection } from '../db/databases.js'
import { withAppKnex } from '../db/provisioner.js'
import {
  type EnvData,
  envData,
  errText,
  type ServerAccess,
  type ServerOpener,
  type SqlExec,
  serverAccessOf,
  serverLoginOf,
  withServerExec
} from './env-db.js'
import {
  backupFactsSql,
  backupFileName,
  backupSql,
  deleteFileSql,
  isCompressionRefusal,
  joinServerPath,
  lastBackupsSql,
  SERVER_FACTS_SQL,
  verifySql
} from './mssql-sql.js'
import { DEFAULT_DB_KEEP_COUNT, readPolicy } from './policy.js'
import { type RunnerDeps, startDataRun } from './runner.js'
import { createRun, keptArtifacts, lastDone, patchRun } from './runs.js'
import { type BackupPolicy, DataError, type DataRun } from './types.js'

/**
 * Hub data care — database backups.
 *
 *  - Automatic: on SQL Server, with the server's stored login, the Hub asks the server for a
 *    COPY_ONLY, checksummed full backup into the policy's folder (or the server's default
 *    backup folder), verifies it (RESTORE VERIFYONLY), records the file, size and time, then
 *    deletes its own older backup files past the retention (xp_delete_file; a refusal is
 *    recorded, never fatal). COPY_ONLY never breaks the DBA's own backup chain.
 *  - Manual (a DBA's server, or Postgres / MySQL / MariaDB, where the server has no BACKUP
 *    statement): a checklist for the DBA and a "last backup seen" read — msdb on SQL Server,
 *    WAL archiving (pg_stat_archiver) on Postgres — plus sightings people record by hand.
 *
 * The Hub never reads the backup's content and never streams data through itself.
 */

export const DB_BACKUP_STEPS = [
  { key: 'prepare', label: 'Check the server and the backup folder' },
  { key: 'backup', label: 'Back up the database (copy-only)' },
  { key: 'verify', label: 'Verify the backup file' },
  { key: 'retention', label: 'Delete older Hub backups past the retention' }
] as const

export interface BackupDeps extends RunnerDeps {
  opener?: ServerOpener
  now?: () => Date
}

/** One backup statement; an edition that refuses compression is asked again without. */
export async function backupInto(
  exec: SqlExec,
  database: string,
  file: string
): Promise<{ compressed: boolean }> {
  try {
    await exec(backupSql(database, file, { compression: true }))
    return { compressed: true }
  } catch (err) {
    if (!isCompressionRefusal(errText(err))) throw err
    await exec(backupSql(database, file, { compression: false }))
    return { compressed: false }
  }
}

export interface BackupFacts {
  size_bytes: number | null
  compressed_bytes: number | null
  finished_at: string | null
}

export async function backupFacts(exec: SqlExec, file: string): Promise<BackupFacts> {
  const [r] = await exec(backupFactsSql(file)).catch(() => [])
  if (!r) return { size_bytes: null, compressed_bytes: null, finished_at: null }
  const n = (v: unknown) => (v == null ? null : Number(v))
  return {
    size_bytes: n(r.backup_size),
    compressed_bytes: n(r.compressed_backup_size),
    finished_at: r.finish_local ? localToUtc(r.finish_local, null, r.server_offset_min) : null
  }
}

/** The folder the backup goes to: the policy's, else the server's default backup folder. */
export async function backupFolder(exec: SqlExec, policyPath: string | null): Promise<string> {
  if (policyPath) return policyPath
  const [f] = await exec(SERVER_FACTS_SQL)
  const p = f?.backup_path ? String(f.backup_path) : ''
  if (!p)
    throw new DataError(
      'BAD_PATH',
      'The server names no default backup folder: set one on the policy.'
    )
  return p
}

/**
 * Which of the Hub's own kept backups retention deletes now: past `keepDays`, or beyond the
 * newest `keepCount` (default 7 when neither is set). The newest backup is never deleted.
 */
export function backupsToDelete(
  kept: Array<Pick<DataRun, 'id' | 'started_at'>>,
  policy: Pick<BackupPolicy, 'db_keep_days' | 'db_keep_count'>,
  now: Date
): number[] {
  const sorted = [...kept].sort((a, b) => b.id - a.id)
  const count = policy.db_keep_count ?? (policy.db_keep_days ? null : DEFAULT_DB_KEEP_COUNT)
  const out: number[] = []
  sorted.forEach((r, i) => {
    if (i === 0) return
    const byCount = count !== null && i >= count
    const age = r.started_at ? now.getTime() - Date.parse(r.started_at) : 0
    const byAge = policy.db_keep_days != null && age > policy.db_keep_days * 86_400_000
    if (byCount || byAge) out.push(r.id)
  })
  return out
}

/** Deletes the files of earlier Hub backups past the retention; answers a sentence. */
export async function pruneDbBackups(
  exec: SqlExec,
  envId: number,
  policy: BackupPolicy,
  now: Date,
  /** The run that just wrote its backup (still running): it counts as the newest one kept. */
  currentRunId: number | null = null,
  /** The server this exec is on: a file another server wrote is left for a DBA. */
  serverId: number | null = null
): Promise<{ deleted: number; failed: number; note: string }> {
  const kept = await keptArtifacts(envId, 'db_backup')
  const ranked =
    currentRunId === null ? kept : [...kept, { id: currentRunId, started_at: now.toISOString() }]
  const ids = new Set(backupsToDelete(ranked, policy, now))
  let deleted = 0
  let failed = 0
  for (const r of kept) {
    if (!ids.has(r.id)) continue
    const file = typeof r.artifact?.file === 'string' ? r.artifact.file : null
    if (!file) continue
    const wrote = Number(r.artifact?.server_id)
    if (serverId !== null && Number.isFinite(wrote) && wrote !== serverId) {
      failed++
      continue
    }
    try {
      await exec(deleteFileSql(file))
      deleted++
      await patchRun(r.id, { artifact: { ...r.artifact, deleted_at: now.toISOString() } })
    } catch (err) {
      failed++
      await patchRun(r.id, {
        artifact: { ...r.artifact, delete_error: errText(err).slice(0, 200) }
      })
    }
  }
  return {
    deleted,
    failed,
    note:
      deleted || failed
        ? `${deleted} older backup file(s) deleted${failed ? `, ${failed} could not be (the login needs sysadmin; a DBA can remove them)` : ''}.`
        : 'Nothing past the retention.'
  }
}

/** Starts a database backup run (refused at once when the Hub cannot back this one up). */
export async function startDbBackup(
  envId: number,
  o: { by: string | null; via?: 'person' | 'schedule'; verify?: boolean },
  deps: BackupDeps = {}
): Promise<number> {
  const data = await envData(envId)
  const access = serverAccessOf(data)
  const policy = await readPolicy(envId)
  const opener = deps.opener ?? withServerExec
  const now = deps.now ?? (() => new Date())
  return startDataRun({
    kind: 'db_backup',
    environmentId: envId,
    envIds: [envId],
    steps: DB_BACKUP_STEPS,
    by: o.by,
    via: o.via,
    deps,
    body: (ctx) =>
      opener(access, async (exec) => {
        let file = ''
        let compressed = false
        await ctx.step('prepare', async () => {
          const folder = await backupFolder(exec, policy.db_path)
          file = joinServerPath(
            folder,
            backupFileName({
              app: data.app.key,
              env: data.env.key,
              label: 'backup',
              runId: ctx.id,
              at: now()
            })
          )
          return `Backing up ${access.database} to ${file}.`
        })
        const started = Date.now()
        await ctx.step('backup', async () => {
          compressed = (await backupInto(exec, access.database, file)).compressed
          return compressed
            ? 'Compressed backup written.'
            : 'Backup written (this edition does not compress).'
        })
        const backupMs = Date.now() - started
        await ctx.step('verify', async () => {
          if (!policy.db_verify && !o.verify)
            return { skipped: true, note: 'Verification is off on the policy.' }
          await exec(verifySql(file))
          return 'The server read the whole file back and its checksums match.'
        })
        const facts = await backupFacts(exec, file)
        const artifact = {
          file,
          database: access.database,
          server_id: access.server.id,
          compressed,
          ...facts
        }
        // Recorded before retention runs, so this backup counts as the newest kept one.
        await ctx.patch({ artifact })
        await ctx.step('retention', async () => {
          const r = await pruneDbBackups(exec, envId, policy, now(), ctx.id, access.server.id)
          return { note: r.note, warn: r.failed > 0 }
        })
        return { result: { backup_ms: backupMs, ...facts }, artifact }
      })
  })
}

// ─── Last backup seen + DBA checklist ──────────────────────────────────────────────────────

export interface LastBackupSeen {
  engine: string | null
  /** Where the times come from: the server's backup history, WAL archiving, or nothing. */
  source: 'msdb' | 'pg_archiver' | 'none'
  full_at: string | null
  diff_at: string | null
  log_at: string | null
  /** Postgres: the last WAL segment archived. */
  archived_at: string | null
  /** The newest Hub backup that finished. */
  hub_at: string | null
  /** The newest sighting a person recorded. */
  recorded: { at: string; by: string | null; note: string | null } | null
  /** The newest of all of the above. */
  newest_at: string | null
  error: string | null
}

const newest = (xs: Array<string | null>) =>
  xs.filter((x): x is string => !!x).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null

/** Reads the server's own backup history for msdb rows: D full, I diff, L log. */
export function parseLastBackups(rows: Record<string, unknown>[]): {
  full_at: string | null
  diff_at: string | null
  log_at: string | null
} {
  const at = (t: string) => {
    const r = rows.find((x) => String(x.type ?? '').trim() === t)
    return r?.finish_local ? localToUtc(r.finish_local, null, r.server_offset_min) : null
  }
  return { full_at: at('D'), diff_at: at('I'), log_at: at('L') }
}

export interface SeenDeps {
  opener?: ServerOpener
  /** The app's own login, when the server has none stored. */
  appRead?: (databaseId: number, sql: string) => Promise<Record<string, unknown>[]>
}

const defaultAppRead = async (databaseId: number, sql: string) =>
  withAppKnex(await openDatabaseConnection(databaseId), async (k) =>
    rawRows<Record<string, unknown>>(await k.raw(sql))
  )

export async function lastBackupSeen(envId: number, deps: SeenDeps = {}): Promise<LastBackupSeen> {
  const data = await envData(envId)
  const out: LastBackupSeen = {
    engine: data.database?.engine ?? null,
    source: 'none',
    full_at: null,
    diff_at: null,
    log_at: null,
    archived_at: null,
    hub_at: null,
    recorded: null,
    newest_at: null,
    error: null
  }
  const hub = await lastDone(envId, 'db_backup')
  out.hub_at = (hub?.artifact?.finished_at as string | null) ?? hub?.finished_at ?? null
  const seen = await lastDone(envId, 'backup_seen')
  if (seen?.result) {
    out.recorded = {
      at: String(seen.result.at ?? seen.finished_at),
      by: seen.started_by,
      note: (seen.result.note as string | null) ?? null
    }
  }
  if (data.database?.status === 'ready') {
    const sql =
      data.database.engine === 'mssql'
        ? lastBackupsSql(data.database.database_name)
        : data.database.engine === 'pg'
          ? 'SELECT last_archived_time FROM pg_stat_archiver'
          : null
    if (sql) {
      try {
        let rows: Record<string, unknown>[]
        let access: ServerAccess | null = null
        try {
          access = serverLoginOf(data)
        } catch {
          access = null
        }
        if (access) rows = await (deps.opener ?? withServerExec)(access, (exec) => exec(sql))
        else rows = await (deps.appRead ?? defaultAppRead)(data.database.id, sql)
        if (data.database.engine === 'mssql') {
          Object.assign(out, parseLastBackups(rows), { source: 'msdb' })
        } else {
          const v = rows[0]?.last_archived_time
          out.archived_at = v ? new Date(String(v)).toISOString() : null
          out.source = 'pg_archiver'
        }
      } catch (err) {
        out.error = `The server’s backup history could not be read: ${errText(err).slice(0, 200)}`
      }
    }
  }
  out.newest_at = newest([
    out.full_at,
    out.diff_at,
    out.log_at,
    out.archived_at,
    out.hub_at,
    out.recorded?.at ?? null
  ])
  return out
}

/** A person records that a backup was taken outside the Hub (the DBA's own job). */
export async function recordBackupSeen(
  envId: number,
  body: Record<string, unknown>,
  by: string | null,
  now = new Date()
): Promise<number> {
  await envData(envId)
  const atRaw = body.at
  const at = atRaw === undefined || atRaw === null || atRaw === '' ? now : new Date(String(atRaw))
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + 5 * 60_000)
    throw new DataError('BAD_POLICY', 'at must be a date and time that is not in the future.', 400)
  const note = body.note
  if (note != null && (typeof note !== 'string' || note.length > 500))
    throw new DataError('BAD_POLICY', 'note must be text of at most 500 characters.', 400)
  return createRun({
    kind: 'backup_seen',
    environmentId: envId,
    steps: [],
    startedBy: by,
    status: 'done',
    result: {
      at: at.toISOString(),
      note: typeof note === 'string' ? note.trim() || null : null
    }
  })
}

export interface ChecklistLine {
  label: string
  value: string
}

/** What the DBA should run when the Hub does not take the backups itself. Pure. */
export function backupChecklist(
  data: Pick<EnvData, 'app' | 'env' | 'database' | 'server'>,
  policy: Pick<BackupPolicy, 'db_schedule' | 'db_keep_days' | 'db_keep_count'>
): ChecklistLine[] {
  const engine = data.database?.engine ?? 'unknown'
  const name = data.database?.database_name ?? '(no database record yet)'
  const lines: ChecklistLine[] = [
    { label: 'Database', value: `${name} on ${data.server?.name ?? data.database?.host ?? '?'}` },
    {
      label: 'Schedule',
      value: policy.db_schedule
        ? `At least as often as ${policy.db_schedule} (UTC)`
        : 'A full backup every day, more often for production'
    },
    {
      label: 'Retention',
      value:
        policy.db_keep_days || policy.db_keep_count
          ? [
              policy.db_keep_days ? `${policy.db_keep_days} days` : null,
              policy.db_keep_count ? `${policy.db_keep_count} backups` : null
            ]
              .filter(Boolean)
              .join(' or ')
          : `${DEFAULT_DB_KEEP_COUNT} backups`
    }
  ]
  if (engine === 'mssql')
    lines.push(
      {
        label: 'How',
        value: 'BACKUP DATABASE … WITH CHECKSUM (to a disk file the server can restore by path)'
      },
      { label: 'What the Hub reads', value: 'msdb backup history (the login needs to read msdb)' }
    )
  else if (engine === 'pg')
    lines.push(
      { label: 'How', value: 'pg_basebackup + WAL archiving, or pg_dump -Fc on a schedule' },
      { label: 'What the Hub reads', value: 'pg_stat_archiver (the last archived WAL segment)' }
    )
  else
    lines.push(
      { label: 'How', value: 'mysqldump --single-transaction (or the provider’s snapshots)' },
      { label: 'What the Hub reads', value: 'Nothing: record each backup as seen on this page' }
    )
  lines.push({
    label: 'Restore test',
    value: 'Restore into a scratch database at least monthly and record how long it took'
  })
  return lines
}
