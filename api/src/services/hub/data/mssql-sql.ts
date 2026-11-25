/**
 * Hub data care on SQL Server — pure: the text of every statement the Hub sends to a database
 * server for a backup, a restore drill, a refresh or a move rehearsal. Nothing here runs SQL.
 *
 * Every statement is sent as plain text through the server's provisioning login (the restore
 * and backup statements take no bindings). Every literal goes through qs()/qi() and every value
 * in one comes from the Hub's own rows (database names, validated folders) or from the server
 * itself (file lists) — never from request text that was not validated here first.
 *
 * Scratch databases (drills, rehearsals) are named nivaro_hub_scratch_<d|r><run id> and carry the
 * extended property nivaro_hub_scratch = <run id>: a database under such a name is only ever
 * dropped when it carries that mark for the same run. Nothing here restores WITH REPLACE except
 * the refresh (and its rollback) over a target the plan proved is not production.
 */
import { createHash } from 'node:crypto'
import { joinServerPath, type MoveTarget, qi, qs } from '../../recovery/plan.js'

export { joinServerPath, qi, qs }

/** Any character below a space (a newline, a NUL …). */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true
  return false
}

export const SCRATCH_PREFIX = 'nivaro_hub_scratch_'
export const SCRATCH_PROPERTY = 'nivaro_hub_scratch'
const SCRATCH_RE = /^nivaro_hub_scratch_[0-9a-f]{8}_[dr][1-9][0-9]{0,9}$/

/**
 * This Hub's own tag (8 hex of a hash of its ENCRYPTION_KEY, never the key): two Hubs that share
 * a database server (a dev and a staging Hub) both have a run 5, and must never take each
 * other's scratch copy for their own. Part of every scratch name and mark.
 */
export function hubTag(env: NodeJS.ProcessEnv = process.env): string {
  return createHash('sha256')
    .update(`nivaro-hub-scratch:${(env.ENCRYPTION_KEY ?? '').trim()}`)
    .digest('hex')
    .slice(0, 8)
}

/** The scratch database of a drill (`d`) or a rehearsal (`r`) run of this Hub. */
export function scratchName(kind: 'd' | 'r', runId: number, tag = hubTag()): string {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('bad run id')
  if (!/^[0-9a-f]{8}$/.test(tag)) throw new Error('bad hub tag')
  return `${SCRATCH_PREFIX}${tag}_${kind}${runId}`
}

/** The mark a scratch copy carries: this Hub's tag and the run id. */
export const scratchMarkValue = (runId: number, tag = hubTag()) => `${tag}:${runId}`

export function isScratchName(name: string): boolean {
  return SCRATCH_RE.test(name)
}

/**
 * A folder on the database server (or a share it writes): `X:\…`, `\\server\share\…` or an
 * absolute POSIX path (SQL Server on Linux). No quotes, semicolons, control characters or `..`.
 */
export function isServerFolder(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const p = v.trim()
  if (!p || p.length > 400 || p !== v) return false
  if (/['";`?]/.test(p) || hasControlChar(p)) return false
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return false
  return /^[A-Za-z]:\\/.test(p) || /^\\\\[A-Za-z0-9._-]+\\[^\\]/.test(p) || /^\/[^/]/.test(p)
}

/** `nivaro_hub_<app>_<env>_<label>_<yyyymmddhhmmss>_<run>.bak` — letters, digits, underscores. */
export function backupFileName(o: {
  app: string
  env: string
  label: string
  runId: number
  at: Date
}): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)
  const stamp = o.at.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `nivaro_hub_${clean(o.app)}_${clean(o.env)}_${clean(o.label)}_${stamp}_${o.runId}.bak`
}

/**
 * A COPY_ONLY full backup (never breaks the DBA's own backup chain), checksummed, into its own
 * new media set (INIT, FORMAT: the file holds this backup only).
 */
export function backupSql(database: string, file: string, opts: { compression: boolean }): string {
  const w = [
    'COPY_ONLY',
    'CHECKSUM',
    'INIT',
    'FORMAT',
    ...(opts.compression ? ['COMPRESSION'] : [])
  ]
  return `BACKUP DATABASE ${qi(database)} TO DISK = ${qs(file)} WITH ${w.join(', ')}, NAME = ${qs(`nivaro hub copy of ${database}`)}`
}

/** The edition refuses compressed backups (Express / Web): retry without. */
export function isCompressionRefusal(message: string): boolean {
  return /compression/i.test(message) && /(not supported|edition)/i.test(message)
}

export function verifySql(file: string): string {
  return `RESTORE VERIFYONLY FROM DISK = ${qs(file)} WITH CHECKSUM`
}

export function headerSql(file: string): string {
  return `RESTORE HEADERONLY FROM DISK = ${qs(file)}`
}

export function fileListSqlFor(file: string): string {
  return `RESTORE FILELISTONLY FROM DISK = ${qs(file)} WITH FILE = 1`
}

/** Size and finish of the backup written to `file` (msdb), newest first. */
export function backupFactsSql(file: string): string {
  return `SELECT TOP 1 CONVERT(float, bs.backup_size) AS backup_size,
    CONVERT(float, bs.compressed_backup_size) AS compressed_backup_size,
    CONVERT(varchar(33), bs.backup_finish_date, 126) AS finish_local,
    DATEDIFF(minute, GETDATE(), GETUTCDATE()) AS server_offset_min
  FROM msdb.dbo.backupset bs JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = bs.media_set_id
  WHERE mf.physical_device_name = ${qs(file)} ORDER BY bs.backup_finish_date DESC`
}

/** Deletes one backup file the Hub wrote (needs sysadmin; a refusal is recorded, not fatal). */
export function deleteFileSql(file: string): string {
  return `EXECUTE master.dbo.xp_delete_file 0, ${qs(file)}`
}

/** What the server is and what this login may do there. */
export const SERVER_FACTS_SQL = `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
  CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition,
  CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400)) AS data_path,
  CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400)) AS log_path,
  CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(400)) AS backup_path,
  HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE ANY DATABASE') AS can_create,
  IS_SRVROLEMEMBER('sysadmin') AS sysadmin,
  CAST(@@SERVERNAME AS nvarchar(200)) AS server`

/** The newest finished backup of each type (D full, I differential, L log) msdb knows. */
export function lastBackupsSql(database: string): string {
  return `SELECT bs.type AS type, CONVERT(varchar(33), MAX(bs.backup_finish_date), 126) AS finish_local,
    DATEDIFF(minute, GETDATE(), GETUTCDATE()) AS server_offset_min
  FROM msdb.dbo.backupset bs
  WHERE bs.database_name = ${qs(database)} AND bs.backup_finish_date IS NOT NULL
  GROUP BY bs.type`
}

export function databaseExistsSql(database: string): string {
  return `SELECT name, state_desc FROM sys.databases WHERE name = ${qs(database)}`
}

/** Every file of a database as the server holds it. */
export function databaseFilesSql(database: string): string {
  return `SELECT name AS logical, physical_name AS physical, type AS type_id
  FROM sys.master_files WHERE database_id = DB_ID(${qs(database)}) ORDER BY file_id`
}

export function scratchMarkReadSql(database: string): string {
  return `SELECT CAST(value AS nvarchar(100)) AS v FROM ${qi(database)}.sys.extended_properties WHERE class = 0 AND name = ${qs(SCRATCH_PROPERTY)}`
}

export function scratchMarkSql(database: string, mark: string): string {
  return `EXECUTE ${qi(database)}.sys.sp_addextendedproperty @name = ${qs(SCRATCH_PROPERTY)}, @value = ${qs(mark)}`
}

export function dropDatabaseSql(database: string): string {
  return `ALTER DATABASE ${qi(database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${qi(database)};`
}

/** Brings a database the Hub took offline back, when a restore never started over it. */
export function onlineSql(database: string): string {
  return `IF DB_ID(${qs(database)}) IS NOT NULL AND DATABASEPROPERTYEX(${qs(database)}, 'Status') = 'OFFLINE' ALTER DATABASE ${qi(database)} SET ONLINE`
}

/** The database's identity on its server: id and creation time (a RESTORE changes the time). */
export function identitySql(database: string): string {
  return `SELECT database_id, CONVERT(varchar(33), create_date, 126) AS create_date FROM sys.databases WHERE name = ${qs(database)}`
}

export interface BackupFile {
  logical: string
  physical: string
  /** D data, L log, F full-text, S FILESTREAM. */
  type: string
}

export interface TargetFile {
  logical: string
  physical: string
  /** sys.master_files.type: 0 rows, 1 log, 2 FILESTREAM, 4 full-text. */
  type_id: number
}

const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')

/**
 * Where each file of the source's backup lands when it replaces the target: the target's own
 * files, data onto data and log onto log in order; a file the target has no twin for gets a new
 * name beside the target's first data (or log) file. The target keeps its file names.
 */
export function movesOverTarget(
  backup: BackupFile[],
  target: TargetFile[],
  stamp: string
): MoveTarget[] {
  const data = target.filter((f) => f.type_id === 0).map((f) => f.physical)
  const logs = target.filter((f) => f.type_id === 1).map((f) => f.physical)
  const dataDir = data[0] ? folderOf(data[0]) : logs[0] ? folderOf(logs[0]) : ''
  const logDir = logs[0] ? folderOf(logs[0]) : dataDir
  let d = 0
  let l = 0
  return backup.map((f, i) => {
    const type = String(f.type || 'D').toUpperCase()
    let physical: string | undefined
    if (type === 'D') physical = data[d++]
    else if (type === 'L') physical = logs[l++]
    if (!physical) {
      const base = `${f.logical.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 60)}_${stamp}_${i}`
      const ext = type === 'L' ? '.ldf' : type === 'D' ? '.ndf' : ''
      physical = joinServerPath(type === 'L' ? logDir : dataDir, `${base}${ext}`)
    }
    return { logical: f.logical, physical, type, size_bytes: null }
  })
}

/**
 * Replaces `target` with the backup in `file`: the database is taken OFFLINE WITH ROLLBACK
 * IMMEDIATE first (every session put out, and nobody — the app's pool included — can connect
 * and take a single-user slot before the restore), then RESTORE … WITH REPLACE, NEW_BROKER (the
 * copy must not share a Service Broker id with its source on the same server). The restore
 * brings it back online.
 */
export function restoreOverSql(target: string, file: string, moves: MoveTarget[]): string {
  const w = [
    'FILE = 1',
    'REPLACE',
    ...moves.map((m) => `MOVE ${qs(m.logical)} TO ${qs(m.physical)}`),
    'RECOVERY',
    'NEW_BROKER',
    'STATS = 10'
  ]
  return `IF DB_ID(${qs(target)}) IS NOT NULL ALTER DATABASE ${qi(target)} SET OFFLINE WITH ROLLBACK IMMEDIATE; RESTORE DATABASE ${qi(target)} FROM DISK = ${qs(file)} WITH ${w.join(', ')};`
}

/** A scratch copy: never REPLACE (the runner proved the name is free or its own leftover). */
export function restoreScratchSql(
  scratch: string,
  file: string,
  moves: MoveTarget[],
  checksum = true
): string {
  const w = [
    'FILE = 1',
    ...moves.map((m) => `MOVE ${qs(m.logical)} TO ${qs(m.physical)}`),
    ...(checksum ? ['CHECKSUM'] : []),
    'RECOVERY',
    'NEW_BROKER',
    'STATS = 10'
  ]
  return `RESTORE DATABASE ${qi(scratch)} FROM DISK = ${qs(file)} WITH ${w.join(', ')}`
}

/**
 * The app's own login owns the restored copy again: its database user is created or re-pointed
 * at the login (a copy from another server or login carries the source's user), and made
 * db_owner as provisioning made it.
 */
export function mapLoginSql(database: string, login: string): string {
  const L = qi(login)
  return `USE ${qi(database)};
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${qs(login)} AND type IN ('S', 'U') AND (sid IS NULL OR sid <> SUSER_SID(${qs(login)})))
  ALTER USER ${L} WITH LOGIN = ${L};
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${qs(login)})
  CREATE USER ${L} FOR LOGIN ${L};
ALTER ROLE db_owner ADD MEMBER ${L};
USE master;`
}

/** The source app's user leaves the target's copy (its login must not reach this database). */
export function dropLoginUserSql(database: string, login: string): string {
  return `USE ${qi(database)}; IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${qs(login)} AND name <> 'dbo') DROP USER ${qi(login)}; USE master;`
}

export function checkdbSql(database: string): string {
  return `DBCC CHECKDB (${qi(database)}) WITH NO_INFOMSGS, PHYSICAL_ONLY`
}

/** How many migrations the database's ledger holds and the newest one. */
export function ledgerSql(database: string): string {
  return `SELECT COUNT(*) AS n, MAX(name) AS latest FROM ${qi(database)}.dbo.${qi('nivaro_migrations')}`
}
