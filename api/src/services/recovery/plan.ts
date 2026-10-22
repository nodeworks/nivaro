/**
 * Restore drill planning (#2801) — pure, no database: msdb rows → which backups to restore,
 * the scratch-name guard, and the RESTORE text. Everything here is unit tested; the runner
 * (drill.ts) only feeds it rows and sends what it builds.
 *
 * Supported: the newest undamaged FULL backup (type D, copy-only included) plus the newest
 * DIFFERENTIAL (type I) taken on top of that full, when both sit on disk files the SQL Server can
 * open (device_type 2; local, mapped or UNC paths, striped media sets included); when the newest
 * full went to a backup agent but an older full sits on disk, that one is restored and the plan
 * says so. Log backups are
 * NOT applied — the drill proves the full + differential restore, and reports how many log
 * backups came after the point it restored to. Backups taken through a backup agent (virtual
 * device, device_type 7 — Cohesity, NetBackup, Veeam…), tape, URL or a named backup device are
 * not restorable by path: the plan says so instead of trying.
 */

export const DRILL_PREFIX = 'nivaro_restore_drill_'

/** Never a drill target, whatever the setting says (case-insensitive). */
export const DENIED_DATABASES = [
  'EFP',
  'EFP_Development',
  'EFP_Staging',
  'master',
  'msdb',
  'model',
  'tempdb',
  'distribution',
  'SSISDB',
  'ReportServer',
  'ReportServerTempDB'
]

const SCRATCH_RE = /^nivaro_restore_drill_[A-Za-z0-9_]{1,100}$/

/**
 * Why `name` may not be the scratch database, or null when it may. The mandatory prefix is half
 * of the ownership mark (the other half, checked live, is the extended property the drill puts
 * on every copy it restores).
 */
export function scratchNameRefusal(name: string, liveNames: string[]): string | null {
  if (!name) return 'no scratch database name'
  if (!SCRATCH_RE.test(name))
    return `the scratch database name must start with ${DRILL_PREFIX} and hold only letters, digits and underscores (got "${name.slice(0, 120)}")`
  const lower = name.toLowerCase()
  if (DENIED_DATABASES.some((d) => d.toLowerCase() === lower))
    return `${name} is a protected database`
  if (liveNames.some((d) => d && d.toLowerCase() === lower))
    return `${name} is this instance's own database`
  return null
}

/** `dbo.table`, `schema.table` or `table`: plain identifiers only. */
export function validTableRef(raw: string): boolean {
  return /^([A-Za-z_][A-Za-z0-9_]{0,127}\.)?[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(raw)
}

export function splitTableRef(ref: string): { schema: string; table: string } {
  const i = ref.indexOf('.')
  return i < 0
    ? { schema: 'dbo', table: ref }
    : { schema: ref.slice(0, i), table: ref.slice(i + 1) }
}

/** Bracket-quoted identifier (`]` doubled). */
export function qi(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`
}

/** N'…' string literal (`'` doubled). Batches are sent as text — never request input. */
export function qs(text: string): string {
  return `N'${text.replace(/'/g, "''")}'`
}

// ── msdb rows ────────────────────────────────────────────────────────────────

export interface BackupSetRow {
  backup_set_id: number
  media_set_id: number
  /** The backup set's position on its media (RESTORE … WITH FILE = n). */
  position: number
  /** D = full, I = differential, L = log (F / G / P / Q file-level types are ignored). */
  type: string
  /** Start / finish as UTC ISO strings (msdb stores server-local time; the reader converts). */
  start_utc: string
  finish_utc: string
  checkpoint_lsn: string | null
  database_backup_lsn: string | null
  is_copy_only: boolean
  is_damaged: boolean
  has_backup_checksums: boolean
  backup_size: number | null
  compressed_backup_size: number | null
}

export interface MediaFamilyRow {
  media_set_id: number
  family_sequence_number: number
  physical_device_name: string
  device_type: number
  mirror: number
}

export const DEVICE_KINDS: Record<number, string> = {
  2: 'disk file',
  5: 'tape',
  7: 'backup agent (virtual device)',
  9: 'Azure storage URL',
  105: 'named backup device'
}

/** '2026-10-22T04:19:10.000Z' → '2026-10-22 04:19 UTC' (reasons and notes people read). */
export function utcText(isoText: string | null | undefined): string {
  if (!isoText) return '—'
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(isoText)
  return m ? `${m[1]} ${m[2]} UTC` : isoText
}

export const deviceKind = (t: number | null | undefined): string =>
  t == null ? 'unknown device' : (DEVICE_KINDS[t] ?? `device type ${t}`)

export interface PlannedBackup {
  backup_set_id: number
  type: 'D' | 'I'
  finish_utc: string
  position: number
  /** Disk paths, in family order (striped media sets have several). */
  devices: string[]
  device_type: number | null
  has_checksums: boolean
  copy_only: boolean
  size_bytes: number | null
}

export interface NewestBackups {
  full: { finish_utc: string; device: string } | null
  diff: { finish_utc: string; device: string } | null
  log: { finish_utc: string; device: string } | null
}

export type PlanRefusal = 'no_backup' | 'not_restorable_by_path' | 'damaged'

export interface DrillPlan {
  ok: boolean
  refusal: PlanRefusal | null
  /** One sentence for people. */
  message: string
  full: PlannedBackup | null
  diff: PlannedBackup | null
  /** The restored copy's point in time (the diff's finish, else the full's). */
  point_utc: string | null
  /** Log backups after that point (not applied). */
  logs_after: number
  notes: string[]
}

function devicesOf(
  mediaSetId: number,
  families: MediaFamilyRow[]
): { devices: string[]; deviceType: number | null; onDisk: boolean } {
  const fam = families
    .filter((f) => f.media_set_id === mediaSetId && Number(f.mirror ?? 0) === 0)
    .sort((a, b) => a.family_sequence_number - b.family_sequence_number)
  const types = [...new Set(fam.map((f) => Number(f.device_type)))]
  const deviceType = types.length === 1 ? types[0] : types.length ? -1 : null
  return {
    devices: fam.map((f) => f.physical_device_name),
    deviceType,
    onDisk:
      fam.length > 0 &&
      types.length === 1 &&
      types[0] === 2 &&
      fam.every(
        (f) => f.physical_device_name && !/^\{?[0-9A-F-]{36}\}?$/i.test(f.physical_device_name)
      )
  }
}

function planned(
  row: BackupSetRow,
  families: MediaFamilyRow[],
  type: 'D' | 'I'
): PlannedBackup & { onDisk: boolean } {
  const d = devicesOf(row.media_set_id, families)
  return {
    backup_set_id: row.backup_set_id,
    type,
    finish_utc: row.finish_utc,
    position: Number(row.position) || 1,
    devices: d.devices,
    device_type: d.deviceType,
    has_checksums: !!row.has_backup_checksums,
    copy_only: !!row.is_copy_only,
    size_bytes: row.compressed_backup_size ?? row.backup_size ?? null,
    onDisk: d.onDisk
  }
}

const byFinishDesc = (a: BackupSetRow, b: BackupSetRow) =>
  a.finish_utc < b.finish_utc
    ? 1
    : a.finish_utc > b.finish_utc
      ? -1
      : b.backup_set_id - a.backup_set_id

/** Newest finish per kind, whatever the device or damage (the RPO row reads this). */
export function newestBackups(rows: BackupSetRow[], families: MediaFamilyRow[]): NewestBackups {
  const sorted = [...rows].sort(byFinishDesc)
  const pick = (t: string) => {
    const r = sorted.find((x) => x.type === t && !x.is_damaged)
    if (!r) return null
    return {
      finish_utc: r.finish_utc,
      device: deviceKind(devicesOf(r.media_set_id, families).deviceType)
    }
  }
  return { full: pick('D'), diff: pick('I'), log: pick('L') }
}

const strip = (p: PlannedBackup & { onDisk: boolean }): PlannedBackup => {
  const { onDisk: _onDisk, ...rest } = p
  return rest
}

/** msdb rows → what the drill restores, or why it cannot. */
export function planRestore(rows: BackupSetRow[], families: MediaFamilyRow[]): DrillPlan {
  const sorted = [...rows].sort(byFinishDesc)
  const notes: string[] = []
  const none = (refusal: PlanRefusal, message: string, full: PlannedBackup | null = null) => ({
    ok: false,
    refusal,
    message,
    full,
    diff: null,
    point_utc: null,
    logs_after: 0,
    notes
  })
  const fulls = sorted.filter((r) => r.type === 'D')
  if (!fulls.length)
    return none('no_backup', 'msdb records no full backup of this database on this server.')
  const fullRow = fulls.find((r) => !r.is_damaged)
  if (!fullRow)
    return none('damaged', 'Every full backup msdb records for this database is marked damaged.')
  if (fullRow !== fulls[0])
    notes.push('The newest full backup is marked damaged; the one before it is used.')
  const newest = planned(fullRow, families, 'D')
  let baseRow = fullRow
  let full = newest
  if (!newest.onDisk) {
    // A backup agent (Cohesity…) and a disk copy side by side: restore the newest disk full and
    // say so — it proves the disk chain, while the RPO row still reads the newest of any kind.
    const disk = fulls.find((r) => !r.is_damaged && devicesOf(r.media_set_id, families).onDisk)
    if (!disk)
      return none(
        'not_restorable_by_path',
        `Backup not restorable by path: the newest full backup was written to a ${deviceKind(newest.device_type)}${
          newest.devices[0] ? ` (${newest.devices[0].slice(0, 200)})` : ''
        }, not a disk file the SQL Server can open, and no full backup on disk is recorded. Restore it through the backup tool, or add a disk backup for the drill.`,
        strip(newest)
      )
    baseRow = disk
    full = planned(disk, families, 'D')
    notes.push(
      `The newest full backup (${utcText(newest.finish_utc)}) was written to a ${deviceKind(newest.device_type)}; the newest full backup on disk (${utcText(disk.finish_utc)}) is restored instead.`
    )
  }
  let diff: PlannedBackup | null = null
  const diffRow = sorted.find(
    (r) =>
      r.type === 'I' &&
      !r.is_damaged &&
      r.finish_utc > baseRow.finish_utc &&
      r.database_backup_lsn != null &&
      baseRow.checkpoint_lsn != null &&
      String(r.database_backup_lsn) === String(baseRow.checkpoint_lsn)
  )
  if (diffRow) {
    const d = planned(diffRow, families, 'I')
    if (d.onDisk) diff = strip(d)
    else
      notes.push(
        `The newest differential sits on a ${deviceKind(d.device_type)}; only the full backup is restored.`
      )
  }
  const point = diff?.finish_utc ?? full.finish_utc
  const logsAfter = sorted.filter((r) => r.type === 'L' && r.finish_utc > point).length
  if (logsAfter)
    notes.push(
      `${logsAfter} log backup${logsAfter === 1 ? '' : 's'} after that point ${logsAfter === 1 ? 'is' : 'are'} not applied.`
    )
  return {
    ok: true,
    refusal: null,
    message: `Restores the newest full backup${baseRow === fullRow ? '' : ' on disk'}${
      diff ? ' and the differential taken on top of it' : ''
    }.`,
    full: strip(full),
    diff,
    point_utc: point,
    logs_after: logsAfter,
    notes
  }
}

// ── RESTORE text ─────────────────────────────────────────────────────────────

export interface FileListRow {
  LogicalName: string
  PhysicalName: string
  /** D data, L log, F full-text catalog, S FILESTREAM / memory-optimized container. */
  Type: string
  FileId: number | string
  Size: number | string | null
}

export interface MoveTarget {
  logical: string
  physical: string
  type: string
  size_bytes: number | null
}

/** `folder` + `name` with the folder's own separator. */
export function joinServerPath(folder: string, name: string): string {
  const sep = folder.includes('/') && !folder.includes('\\') ? '/' : '\\'
  return `${folder.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** One unique physical file (or container folder) per logical file of the backup. */
export function planMoves(
  files: FileListRow[],
  scratch: string,
  dataPath: string,
  logPath: string,
  stamp: string
): MoveTarget[] {
  let firstData = true
  return files.map((f) => {
    const type = String(f.Type ?? 'D').toUpperCase()
    const id = String(f.FileId ?? '0').replace(/\D/g, '') || '0'
    const base = `${scratch}_${stamp}_${id}`
    let name: string
    if (type === 'L') name = `${base}.ldf`
    else if (type === 'D') {
      name = `${base}.${firstData ? 'mdf' : 'ndf'}`
      firstData = false
    } else name = base // FILESTREAM / full-text: a folder
    const size = f.Size == null ? null : Number(f.Size)
    return {
      logical: String(f.LogicalName),
      physical: joinServerPath(type === 'L' ? logPath : dataPath, name),
      type,
      size_bytes: Number.isFinite(size) ? size : null
    }
  })
}

const fromDisks = (devices: string[]) => devices.map((d) => `DISK = ${qs(d)}`).join(', ')

export function fileListSql(b: PlannedBackup): string {
  return `RESTORE FILELISTONLY FROM ${fromDisks(b.devices)} WITH FILE = ${Math.max(1, Math.trunc(b.position))}`
}

/**
 * One RESTORE DATABASE step. The full runs WITH NORECOVERY when a differential follows. No
 * REPLACE: the runner has proved the scratch database does not exist (or dropped its own
 * leftover), file names are unique per run, so REPLACE could only ever overwrite something the
 * drill does not own. NEW_BROKER keeps the copy's Service Broker apart from the live database's.
 */
export function restoreSql(
  scratch: string,
  b: PlannedBackup,
  moves: MoveTarget[],
  opts: { recovery: boolean }
): string {
  const parts = [
    `FILE = ${Math.max(1, Math.trunc(b.position))}`,
    ...(b.type === 'D' ? moves.map((m) => `MOVE ${qs(m.logical)} TO ${qs(m.physical)}`) : []),
    ...(b.has_checksums ? ['CHECKSUM'] : []),
    opts.recovery ? 'RECOVERY' : 'NORECOVERY',
    ...(opts.recovery ? ['NEW_BROKER'] : []),
    'STATS = 10'
  ]
  return `RESTORE DATABASE ${qi(scratch)} FROM ${fromDisks(b.devices)} WITH ${parts.join(', ')}`
}
