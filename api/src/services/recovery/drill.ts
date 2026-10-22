import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { errorText } from '../../lib/db-refusal.js'
import { runLongSql, withLongConnection } from '../run-long.js'
import { currentTenantKey } from '../tenant-rooms.js'
import {
  type BackupSetRow,
  type DrillPlan,
  type FileListRow,
  fileListSql,
  type MediaFamilyRow,
  type MoveTarget,
  type NewestBackups,
  newestBackups,
  planMoves,
  planRestore,
  qi,
  qs,
  restoreSql,
  scratchNameRefusal,
  splitTableRef,
  utcText
} from './plan.js'
import { type EffectiveRecovery, scratchNameFor } from './settings.js'
import {
  CHECKSUM_TABLES,
  type ChecksumRead,
  judgeSmoke,
  KEY_TABLES,
  type SmokeResult,
  type TableCount
} from './smoke.js'

/**
 * Nightly restore drill (#2801): "a backup that has never been restored is not a backup."
 *
 *   1. read msdb for the newest full (+ differential) backup of DB_DATABASE      (plan.ts)
 *   2. RESTORE FILELISTONLY, the login's CREATE ANY DATABASE right, the default data / log
 *      paths and the free space on their volumes
 *   3. RESTORE DATABASE into the scratch database (nivaro_restore_drill_…), timed — the
 *      measured restore time is the RTO input
 *   4. smoke: key tables exist and are non-empty where live is non-empty; row counts and
 *      CHECKSUM_AGG over small config tables recorded beside the live ones   (smoke.ts)
 *   5. DROP the scratch database — always, in finally, and only one this drill owns
 *
 * Ownership: the scratch name must carry the nivaro_restore_drill_ prefix, may never be a
 * protected database or this instance's own, and a database already under that name is dropped
 * only when it carries the drill's extended property (set right after every restore) or msdb
 * shows it was restored from this database's backups and never finished (a killed drill).
 * Anything else refuses the run.
 *
 * Every refusal — msdb not readable, no CREATE DATABASE right, backup on a virtual device or a
 * path the server cannot open, not enough disk — is a recorded result, never a crash. Batches
 * are plain text through run-long (no bindings): every literal goes through qs()/qi(), and every
 * value in them comes from msdb, the server or validated settings — never request input.
 *
 * The result rides the drill's own nivaro_job_runs row (the CronManager's row for the
 * `restore-drill` job) in its `progress` column as JSON (`kind: 'restore-drill'`).
 */

export const DRILL_JOB_ID = 'restore-drill'
export const DRILL_PROPERTY = 'nivaro_restore_drill'

export type DrillVerdict = 'passed' | 'failed' | 'blocked' | 'skipped' | 'ready'

export interface DrillStep {
  step: 'full' | 'diff'
  ms: number
  ok: boolean
  error: string | null
}

export interface DrillResult {
  kind: 'restore-drill'
  v: 1
  mode: 'run' | 'dry_run'
  verdict: DrillVerdict
  /** One sentence for people. */
  reason: string
  /** While running: where it is. */
  phase: string | null
  started_at: string
  finished_at: string | null
  database: string
  scratch_db: string | null
  server: string | null
  plan: DrillPlan | null
  newest: NewestBackups | null
  /** Drill start minus the restored point (the data the copy lacks). */
  backup_age_s: number | null
  can_create_db: boolean | null
  files: MoveTarget[] | null
  needed_bytes: number | null
  free_bytes: number | null
  /** Full + differential RESTORE time: the measured RTO input. */
  restore_ms: number | null
  steps: DrillStep[]
  smoke: SmokeResult | null
  checkdb: { ok: boolean; ms: number; error: string | null } | null
  /**
   * The ownership record, written to the run's job row BEFORE any RESTORE: the only thing that
   * lets a later drill (or this one's cleanup) treat a database under the scratch name as its own.
   */
  claim: { scratch_db: string; run_id: number | null; claimed_at: string } | null
  /** The copy carries the drill's extended property. */
  marked: boolean | null
  leftover_dropped: boolean
  dropped: boolean | null
  drop_error: string | null
  total_ms: number | null
}

const RESULT_MAX_CHARS = 60_000

function base(mode: DrillResult['mode']): DrillResult {
  return {
    kind: 'restore-drill',
    v: 1,
    mode,
    verdict: 'skipped',
    reason: '',
    phase: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    database: config.DB_DATABASE,
    scratch_db: null,
    server: null,
    plan: null,
    newest: null,
    backup_age_s: null,
    can_create_db: null,
    files: null,
    needed_bytes: null,
    free_bytes: null,
    restore_ms: null,
    steps: [],
    smoke: null,
    checkdb: null,
    claim: null,
    marked: null,
    leftover_dropped: false,
    dropped: null,
    drop_error: null,
    total_ms: null
  }
}

/** A drill result as stored text (capped: table detail goes first when it is too long). */
export function serializeResult(r: DrillResult): string {
  let s = JSON.stringify(r)
  if (s.length <= RESULT_MAX_CHARS) return s
  s = JSON.stringify({
    ...r,
    smoke: r.smoke ? { ...r.smoke, tables: r.smoke.tables.slice(0, 20) } : null
  })
  return s.length <= RESULT_MAX_CHARS
    ? s
    : JSON.stringify({ ...r, smoke: null, files: null, plan: null })
}

export function parseResult(raw: unknown): DrillResult | null {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null
  try {
    const o = JSON.parse(raw)
    return o && o.kind === 'restore-drill' ? (o as DrillResult) : null
  } catch {
    return null
  }
}

// ── SQL reads (all plain batches; literals through qs / qi) ──────────────────

/** msdb backup history for one database: newest 5 full, 5 differential, 100 log backups. Times
 *  come back as server-local text with the backup's own time_zone; localToUtc() converts them. */
export function backupSetSql(database: string): string {
  const cols = `bs.backup_set_id, bs.media_set_id, bs.position, bs.type,
    CONVERT(varchar(33), bs.backup_start_date, 126) AS start_local,
    CONVERT(varchar(33), bs.backup_finish_date, 126) AS finish_local,
    bs.time_zone AS tz, DATEDIFF(minute, GETDATE(), GETUTCDATE()) AS server_offset_min,
    CONVERT(varchar(40), bs.checkpoint_lsn) AS checkpoint_lsn,
    CONVERT(varchar(40), bs.database_backup_lsn) AS database_backup_lsn,
    bs.is_copy_only, bs.is_damaged, bs.has_backup_checksums,
    CONVERT(float, bs.backup_size) AS backup_size, CONVERT(float, bs.compressed_backup_size) AS compressed_backup_size`
  const one = (type: string, n: number) =>
    `SELECT * FROM (SELECT TOP (${n}) ${cols} FROM msdb.dbo.backupset bs WHERE bs.database_name = ${qs(database)} AND bs.type = '${type}' AND bs.backup_finish_date IS NOT NULL ORDER BY bs.backup_finish_date DESC) x_${type}`
  return [one('D', 5), one('I', 5), one('L', 100)].join(' UNION ALL ')
}

/**
 * msdb stores backup times in the SQL Server's local time, with `time_zone` = the offset from
 * UTC at the backup's start in 15-minute intervals (-48…+48; 127 = unknown). Local text from
 * CONVERT(…, 126) → UTC ISO. Unknown zone → the server's offset now (`serverOffsetMin` =
 * UTC − local, minutes). Unreadable text comes back unchanged.
 */
export function localToUtc(localText: unknown, tz: unknown, serverOffsetMin: unknown): string {
  const t = String(localText ?? '')
  if (!t) return t
  const ms = Date.parse(t.endsWith('Z') ? t : `${t}Z`)
  if (Number.isNaN(ms)) return t
  const zone = tz == null || tz === '' ? Number.NaN : Number(tz)
  const offsetMin =
    Number.isInteger(zone) && zone >= -48 && zone <= 48 ? -15 * zone : Number(serverOffsetMin) || 0
  return new Date(ms + offsetMin * 60_000).toISOString()
}

export async function readBackupHistory(
  database: string
): Promise<{ sets: BackupSetRow[]; families: MediaFamilyRow[] }> {
  const raw = await runLongSql<Record<string, unknown>>(backupSetSql(database), {
    timeoutMs: 60_000
  })
  const sets: BackupSetRow[] = raw.map((r) => ({
    backup_set_id: Number(r.backup_set_id),
    media_set_id: Number(r.media_set_id),
    position: Number(r.position ?? 1),
    type: String(r.type ?? '').trim(),
    start_utc: localToUtc(r.start_local, r.tz, r.server_offset_min),
    finish_utc: localToUtc(r.finish_local, r.tz, r.server_offset_min),
    checkpoint_lsn: r.checkpoint_lsn == null ? null : String(r.checkpoint_lsn),
    database_backup_lsn: r.database_backup_lsn == null ? null : String(r.database_backup_lsn),
    is_copy_only: !!r.is_copy_only,
    is_damaged: !!r.is_damaged,
    has_backup_checksums: !!r.has_backup_checksums,
    backup_size: r.backup_size == null ? null : Number(r.backup_size),
    compressed_backup_size:
      r.compressed_backup_size == null ? null : Number(r.compressed_backup_size)
  }))
  const ids = [...new Set(sets.map((s) => s.media_set_id).filter(Number.isFinite))]
  const families = ids.length
    ? (
        await runLongSql<Record<string, unknown>>(
          `SELECT media_set_id, family_sequence_number, physical_device_name, device_type, mirror FROM msdb.dbo.backupmediafamily WHERE media_set_id IN (${ids.map((i) => Math.trunc(i)).join(',')})`,
          { timeoutMs: 60_000 }
        )
      ).map((f) => ({
        media_set_id: Number(f.media_set_id),
        family_sequence_number: Number(f.family_sequence_number ?? 1),
        physical_device_name: String(f.physical_device_name ?? ''),
        device_type: Number(f.device_type),
        mirror: Number(f.mirror ?? 0)
      }))
    : []
  return { sets, families }
}

interface ServerFacts {
  can_create: boolean
  data_path: string | null
  log_path: string | null
  server: string | null
}

async function serverFacts(): Promise<ServerFacts> {
  const [r] = await runLongSql<Record<string, unknown>>(
    `SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE ANY DATABASE') AS can_create,
      CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400)) AS data_path,
      CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400)) AS log_path,
      CAST(@@SERVERNAME AS nvarchar(200)) AS server`,
    { timeoutMs: 30_000 }
  )
  return {
    can_create: Number(r?.can_create ?? 0) === 1,
    data_path: r?.data_path ? String(r.data_path) : null,
    log_path: r?.log_path ? String(r.log_path) : null,
    server: r?.server ? String(r.server) : null
  }
}

/** Free bytes on the volume holding `path`, from any database file on it; null = unknown. */
export function freeBytesFor(
  path: string,
  volumes: Array<{ mount: string; free: number }>
): number | null {
  const p = path.toLowerCase().replace(/\//g, '\\')
  let best: { len: number; free: number } | null = null
  for (const v of volumes) {
    const m = v.mount.toLowerCase().replace(/\//g, '\\')
    if (m && p.startsWith(m) && (!best || m.length > best.len))
      best = { len: m.length, free: v.free }
  }
  return best ? best.free : null
}

async function volumeFreeSpace(): Promise<Array<{ mount: string; free: number }> | null> {
  try {
    const rows = await runLongSql<{ mount: string; free: number }>(
      `SELECT DISTINCT vs.volume_mount_point AS mount, CONVERT(float, vs.available_bytes) AS free
       FROM sys.master_files mf CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs`,
      { timeoutMs: 30_000 }
    )
    return rows.map((r) => ({ mount: String(r.mount ?? ''), free: Number(r.free) }))
  } catch {
    return null // needs VIEW SERVER STATE; unknown free space never blocks
  }
}

/** Row counts (sys.partitions: cheap, any rights on the table) for `refs` in `database`. */
export function tableCountSql(database: string, refs: string[]): string {
  const d = qi(database)
  const bySchema = new Map<string, string[]>()
  for (const ref of refs) {
    const { schema, table } = splitTableRef(ref)
    bySchema.set(schema, [...(bySchema.get(schema) ?? []), table])
  }
  const where = [...bySchema]
    .map(([s, ts]) => `(s.name = ${qs(s)} AND t.name IN (${ts.map(qs).join(', ')}))`)
    .join(' OR ')
  return `SELECT s.name AS sch, t.name AS tbl, CONVERT(float, SUM(p.rows)) AS n
    FROM ${d}.sys.tables t
    JOIN ${d}.sys.schemas s ON s.schema_id = t.schema_id
    JOIN ${d}.sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    WHERE ${where || '1 = 0'}
    GROUP BY s.name, t.name`
}

async function tableCounts(database: string, refs: string[]): Promise<TableCount[]> {
  const rows = await runLongSql<{ sch: string; tbl: string; n: number }>(
    tableCountSql(database, refs),
    { timeoutMs: 120_000 }
  )
  const found = new Map(rows.map((r) => [`${r.sch}.${r.tbl}`.toLowerCase(), Number(r.n)]))
  return refs.map((ref) => {
    const { schema, table } = splitTableRef(ref)
    const n = found.get(`${schema}.${table}`.toLowerCase())
    return { ref, exists: n !== undefined, rows: n ?? null }
  })
}

async function checksum(database: string, ref: string): Promise<number | null> {
  const { schema, table } = splitTableRef(ref)
  const [r] = await runLongSql<{ c: number | null }>(
    `SELECT CHECKSUM_AGG(BINARY_CHECKSUM(*)) AS c FROM ${qi(database)}.${qi(schema)}.${qi(table)}`,
    { timeoutMs: 120_000 }
  )
  return r?.c == null ? null : Number(r.c)
}

/**
 * Where the drill records which scratch databases it made. `claim` must persist (or throw)
 * before any RESTORE; `owns` answers whether the newest recorded claim on a name belongs to a run
 * whose copy was not confirmed dropped. A database under the scratch name is the drill's ONLY when
 * `owns` says so: msdb restorehistory is not used (it records completed restores only), and the
 * extended property is a mark for people, never proof on its own.
 */
export interface DrillLedger {
  claim(r: DrillResult): Promise<void>
  owns(scratch: string): Promise<boolean>
}

type Owner =
  | { exists: false }
  | { exists: true; ours: boolean; state: string; marked: boolean | null }

/** Whether a database under the scratch name exists, and whether the ledger says the drill made it. */
async function scratchOwnership(scratch: string, ledger: DrillLedger): Promise<Owner> {
  const [row] = await runLongSql<{ state: string | null }>(
    `SELECT CONVERT(nvarchar(60), DATABASEPROPERTYEX(${qs(scratch)}, 'Status')) AS state WHERE DB_ID(${qs(scratch)}) IS NOT NULL`,
    { timeoutMs: 30_000 }
  )
  if (!row) return { exists: false }
  const state = String(row.state ?? '')
  let marked: boolean | null = null
  if (state === 'ONLINE') {
    const [p] = await runLongSql<{ v: string | null }>(
      `SELECT CONVERT(nvarchar(200), value) AS v FROM ${qi(scratch)}.sys.extended_properties WHERE class = 0 AND name = ${qs(DRILL_PROPERTY)}`,
      { timeoutMs: 30_000 }
    ).catch(() => [])
    marked = !!p
  }
  return { exists: true, ours: await ledger.owns(scratch), state, marked }
}

/** DROP the scratch database (online → single user first). Re-checks the name guard. */
async function dropScratch(scratch: string, live: string): Promise<void> {
  const why = scratchNameRefusal(scratch, [live])
  if (why) throw new Error(`refused to drop ${scratch}: ${why}`)
  await withLongConnection(async (c) => {
    await c.run(
      `IF DATABASEPROPERTYEX(${qs(scratch)}, 'Status') = 'ONLINE' ALTER DATABASE ${qi(scratch)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`,
      120_000
    )
    await c.run(`IF DB_ID(${qs(scratch)}) IS NOT NULL DROP DATABASE ${qi(scratch)}`, 300_000)
  })
}

/** "Operating system error 5", "Cannot open backup device" … → the path is the problem. */
export function isPathError(message: string): boolean {
  return /cannot open backup device|operating system error|access is denied|the system cannot find|3201\b|does not exist/i.test(
    message
  )
}

const TAKEN_MARK = 'nivaro-restore-drill: scratch name taken'

/** First statement of the full restore's batch: refuse when the scratch name exists. */
export function notTakenGuard(scratch: string): string {
  return `IF DB_ID(${qs(scratch)}) IS NOT NULL THROW 50001, ${qs(TAKEN_MARK)}, 1;`
}

const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14)

// ── The run ──────────────────────────────────────────────────────────────────

/** Tenants with a drill in flight on this process. */
const running = new Set<string>()
export const isDrillRunning = (): boolean => running.has(currentTenantKey())

export interface DrillOptions {
  dryRun: boolean
  settings: EffectiveRecovery
  /** Called with the result so far at each phase (the runner stores it on the job row). */
  onPhase?: (r: DrillResult) => void | Promise<void>
  /** Ownership records. A run that cannot record its claim never restores. */
  ledger?: DrillLedger
}

/** No ledger (a dry run outside a job): nothing is ever the drill's, and claims fail. */
const EMPTY_LEDGER: DrillLedger = {
  claim: async () => {
    throw new Error('no run record to write the ownership claim to')
  },
  owns: async () => false
}

export async function runRestoreDrill(opts: DrillOptions): Promise<DrillResult> {
  const t0 = Date.now()
  const r = base(opts.dryRun ? 'dry_run' : 'run')
  const live = config.DB_DATABASE
  const s = opts.settings
  const finish = (verdict: DrillVerdict, reason: string): DrillResult => {
    r.verdict = verdict
    r.reason = reason
    r.phase = null
    r.finished_at = new Date().toISOString()
    r.total_ms = Date.now() - t0
    return r
  }
  const phase = async (p: string) => {
    r.phase = p
    try {
      await opts.onPhase?.(r)
    } catch {
      /* bookkeeping only */
    }
  }

  if (s.cloud) return finish('skipped', 'Restore drills do not run on cloud instances.')
  if (config.DB_CLIENT !== 'mssql') return finish('skipped', 'Restore drills need SQL Server.')
  if (!opts.dryRun && !s.drill_enabled)
    return finish(
      'skipped',
      'The restore drill is off on this instance (RESTORE_DRILL or the setting).'
    )

  const scratch = scratchNameFor(s.restore_drill, live)
  r.scratch_db = scratch
  const refused = scratchNameRefusal(scratch, [live])
  if (refused) return finish('blocked', `Scratch database refused: ${refused}.`)

  const tenant = currentTenantKey()
  if (!opts.dryRun) {
    if (running.has(tenant)) return finish('skipped', 'A restore drill is already running here.')
    running.add(tenant)
  }
  const ledger = opts.ledger ?? EMPTY_LEDGER
  /** A RESTORE got past the name guard: a copy may exist, ours by this run's claim. */
  let attempted = false
  try {
    await phase('reading msdb')
    let history: Awaited<ReturnType<typeof readBackupHistory>>
    try {
      history = await readBackupHistory(live)
    } catch (err) {
      return finish(
        'blocked',
        `Cannot read the backup history in msdb (${errorText(err, 300)}). The login needs SELECT on msdb.dbo.backupset and backupmediafamily.`
      )
    }
    r.newest = newestBackups(history.sets, history.families)
    // The server's facts first (read-only): a refused plan still records whether the login could
    // restore at all, so fixing one blocker does not reveal the next a night later.
    let facts: ServerFacts | null = null
    let factsError: string | null = null
    try {
      facts = await serverFacts()
      r.server = facts.server
      r.can_create_db = facts.can_create
    } catch (err) {
      factsError = errorText(err, 300)
    }
    const plan = planRestore(history.sets, history.families)
    r.plan = plan
    if (!plan.ok)
      return finish(
        'blocked',
        facts && !facts.can_create
          ? `${plan.message} The database login also lacks CREATE ANY DATABASE.`
          : plan.message
      )
    r.backup_age_s = plan.point_utc
      ? Math.max(0, Math.round((t0 - Date.parse(plan.point_utc)) / 1000))
      : null

    await phase('checking rights and space')
    if (!facts) return finish('blocked', `Cannot read the server's settings: ${factsError}`)
    if (!facts.can_create)
      return finish(
        'blocked',
        'The database login lacks CREATE ANY DATABASE (the dbcreator role), which RESTORE and RESTORE FILELISTONLY need.'
      )

    const full = plan.full!
    let files: FileListRow[]
    try {
      files = await runLongSql<FileListRow>(fileListSql(full), { timeoutMs: 5 * 60_000 })
    } catch (err) {
      const msg = errorText(err, 400)
      return finish(
        'blocked',
        isPathError(msg)
          ? `Backup not restorable by path: the SQL Server cannot open ${full.devices[0] ?? 'the backup file'} (${msg}).`
          : `RESTORE FILELISTONLY failed: ${msg}`
      )
    }
    const dataPath = s.restore_drill.data_path ?? facts.data_path
    const logPath = s.restore_drill.log_path ?? facts.log_path ?? dataPath
    if (!dataPath || !logPath)
      return finish(
        'blocked',
        'The server reports no default data or log folder; set the drill’s data and log paths.'
      )
    const moves = planMoves(files, scratch, dataPath, logPath, stamp())
    r.files = moves
    r.needed_bytes = moves.reduce((a, m) => a + (m.size_bytes ?? 0), 0)
    const volumes = await volumeFreeSpace()
    if (volumes) {
      const dataNeed = moves
        .filter((m) => m.type !== 'L')
        .reduce((a, m) => a + (m.size_bytes ?? 0), 0)
      const logNeed = moves
        .filter((m) => m.type === 'L')
        .reduce((a, m) => a + (m.size_bytes ?? 0), 0)
      const dataFree = freeBytesFor(dataPath, volumes)
      const logFree = freeBytesFor(logPath, volumes)
      const sameVolume = dataFree != null && logFree != null && dataFree === logFree
      r.free_bytes = dataFree
      const short = (need: number, free: number | null) => free != null && need * 1.1 > free
      if (
        sameVolume
          ? short(dataNeed + logNeed, dataFree)
          : short(dataNeed, dataFree) || short(logNeed, logFree)
      )
        return finish(
          'blocked',
          `Not enough disk for the restored copy: it needs ${gb(r.needed_bytes)} and the target volume has ${gb(dataFree ?? logFree ?? 0)} free.`
        )
    }

    const owner = await scratchOwnership(scratch, ledger)
    if (owner.exists && !owner.ours)
      return finish(
        'blocked',
        `A database named ${scratch} (${owner.state || 'unknown state'}) already exists and no drill run recorded creating it. Drop or rename it by hand, or pick another scratch name.`
      )

    if (opts.dryRun)
      return finish(
        'ready',
        `Ready: would restore the ${full.copy_only ? 'copy-only ' : ''}full backup of ${utcText(full.finish_utc)}${
          plan.diff ? ` and the differential of ${utcText(plan.diff.finish_utc)}` : ''
        } into ${scratch} (${gb(r.needed_bytes)})${owner.exists ? `, after dropping the drill's leftover copy (${owner.state})` : ''}.`
      )

    // The ownership claim, before anything is created or dropped: no claim, no restore.
    r.claim = { scratch_db: scratch, run_id: null, claimed_at: new Date().toISOString() }
    try {
      await ledger.claim(r)
    } catch (err) {
      r.claim = null
      return finish(
        'blocked',
        `Could not record the drill's ownership claim before restoring (${errorText(err, 200)}); nothing was restored.`
      )
    }

    if (owner.exists) {
      await phase('dropping a leftover copy')
      await dropScratch(scratch, live)
      r.leftover_dropped = true
    }

    // RESTORE — timed; that time is the measured restore part of the RTO.
    const timeoutMs = s.restore_drill.max_restore_minutes * 60_000
    const steps: Array<{ b: typeof full; recovery: boolean }> = plan.diff
      ? [
          { b: full, recovery: false },
          { b: plan.diff, recovery: true }
        ]
      : [{ b: full, recovery: true }]
    for (const st of steps) {
      await phase(st.b.type === 'D' ? 'restoring the full backup' : 'restoring the differential')
      const t = Date.now()
      // The full restore refuses in the same batch when the name was taken since the ownership
      // check: the drill never restores over, or later drops, a database it did not create.
      const sql = restoreSql(scratch, st.b, moves, { recovery: st.recovery })
      try {
        attempted = true
        await runLongSql(st.b.type === 'D' ? `${notTakenGuard(scratch)}\n${sql}` : sql, {
          timeoutMs
        })
        r.steps.push({
          step: st.b.type === 'D' ? 'full' : 'diff',
          ms: Date.now() - t,
          ok: true,
          error: null
        })
      } catch (err) {
        const msg = errorText(err, 600)
        if (st.b.type === 'D' && msg.includes(TAKEN_MARK)) {
          attempted = false // the guard stopped it: whatever holds the name is not ours
          return finish(
            'blocked',
            `A database named ${scratch} appeared while the drill was checking; nothing was restored.`
          )
        }
        r.steps.push({
          step: st.b.type === 'D' ? 'full' : 'diff',
          ms: Date.now() - t,
          ok: false,
          error: msg
        })
        return finish(
          isPathError(msg) ? 'blocked' : 'failed',
          isPathError(msg)
            ? `Backup not restorable by path: ${msg}`
            : `RESTORE of the ${st.b.type === 'D' ? 'full backup' : 'differential'} failed: ${msg}`
        )
      }
    }
    r.restore_ms = r.steps.reduce((a, x) => a + x.ms, 0)
    try {
      await runLongSql(
        `EXEC ${qi(scratch)}.sys.sp_addextendedproperty @name = ${qs(DRILL_PROPERTY)}, @value = ${qs(r.started_at)}`,
        { timeoutMs: 60_000 }
      )
      r.marked = true
    } catch (err) {
      r.marked = false
      return finish(
        'failed',
        `Restored in ${fmtMs(r.restore_ms)}, but the copy could not be marked as the drill's (${errorText(err, 300)}).`
      )
    }

    await phase('checking the restored copy')
    const refs = [...new Set([...KEY_TABLES, ...s.restore_drill.business_tables])]
    let opened = false
    let openError: string | null = null
    try {
      const [st] = await runLongSql<{ state: string | null }>(
        `SELECT CONVERT(nvarchar(60), DATABASEPROPERTYEX(${qs(scratch)}, 'Status')) AS state`,
        { timeoutMs: 30_000 }
      )
      opened = st?.state === 'ONLINE'
      if (!opened) openError = `state ${st?.state ?? 'unknown'}`
    } catch (err) {
      openError = errorText(err, 300)
    }
    let liveCounts: TableCount[] = refs.map((ref) => ({ ref, exists: false, rows: null }))
    let copyCounts: TableCount[] = []
    try {
      liveCounts = await tableCounts(live, refs)
      if (opened) copyCounts = await tableCounts(scratch, refs)
    } catch (err) {
      opened = false
      openError = `the copy's tables could not be read: ${errorText(err, 300)}`
    }
    const sums: ChecksumRead[] = []
    if (opened)
      for (const ref of CHECKSUM_TABLES) {
        const one: ChecksumRead = { ref, live: null, restored: null, error: null }
        try {
          one.live = await checksum(live, ref)
          one.restored = await checksum(scratch, ref)
        } catch (err) {
          one.error = errorText(err, 200)
        }
        sums.push(one)
      }
    r.smoke = judgeSmoke({
      opened,
      openError,
      live: liveCounts,
      restored: copyCounts,
      checksums: sums
    })

    if (opened && s.restore_drill.checkdb) {
      await phase('DBCC CHECKDB')
      const t = Date.now()
      try {
        await runLongSql(`DBCC CHECKDB (${qs(scratch)}) WITH PHYSICAL_ONLY, NO_INFOMSGS`, {
          timeoutMs
        })
        r.checkdb = { ok: true, ms: Date.now() - t, error: null }
      } catch (err) {
        r.checkdb = { ok: false, ms: Date.now() - t, error: errorText(err, 600) }
      }
    }

    const restoreText = `restore ${fmtMs(r.restore_ms)}`
    if (!r.smoke.passed)
      return finish(
        'failed',
        `Restored (${restoreText}) but the smoke check failed: ${r.smoke.summary}`
      )
    if (r.checkdb && !r.checkdb.ok)
      return finish(
        'failed',
        `Restored (${restoreText}) but DBCC CHECKDB reported: ${r.checkdb.error}`
      )
    return finish(
      'passed',
      `Restored the backup of ${utcText(plan.point_utc)} in ${fmtMs(r.restore_ms)}. ${r.smoke.summary}`
    )
  } catch (err) {
    return finish('failed', `The drill stopped: ${errorText(err, 600)}`)
  } finally {
    // Clean up only what exists and is ours by the ledger (re-checked here, never assumed).
    if (attempted) {
      const cleanupFailed = (why: string) => {
        r.dropped = false
        r.drop_error = why
        r.verdict = 'failed'
        r.reason = `${r.reason} The scratch copy ${scratch} is still on the server: ${why}`
      }
      try {
        const now = await scratchOwnership(scratch, ledger)
        if (!now.exists) r.dropped = null
        else if (!now.ours)
          cleanupFailed('no recorded claim makes it the drill’s, so it was not dropped.')
        else {
          await dropScratch(scratch, live)
          r.dropped = true
        }
      } catch (err) {
        cleanupFailed(`it could not be dropped (${errorText(err, 400)}).`)
      }
    }
    if (!opts.dryRun) running.delete(tenant)
  }
}

export function gb(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
}

export function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round((ms / 3_600_000) * 10) / 10} h`
}

// ── The job row ──────────────────────────────────────────────────────────────

/** The CronManager's running row for this drill (scheduled tick or run-now). */
async function ownRunRow(): Promise<number | null> {
  try {
    const row = (await db('nivaro_job_runs')
      .where({ job_id: DRILL_JOB_ID, status: 'running' })
      .where('started_at', '>', new Date(Date.now() - 4 * 3_600_000))
      .orderBy('id', 'desc')
      .first('id')) as { id: number } | undefined
    return row ? Number(row.id) : null
  } catch {
    return null
  }
}

/**
 * The ledger on nivaro_job_runs: a claim is this run's own row (job restore-drill) with the result
 * JSON carrying `claim`; the newest claim on a scratch name owns it until that run recorded
 * `dropped: true`. Rows are pruned with the job history (newest 50 / 30 days): a leftover older
 * than that is refused, never guessed.
 */
export function jobRunLedger(rowId: number | null): DrillLedger {
  return {
    async claim(r) {
      if (rowId == null) throw new Error('the drill has no job run row')
      if (r.claim) r.claim.run_id = rowId
      const n = await db('nivaro_job_runs')
        .where('id', rowId)
        .update({ progress: serializeResult(r) })
      if (!Number(n)) throw new Error(`job run ${rowId} was not updated`)
    },
    async owns(scratch) {
      const rows = (await db('nivaro_job_runs')
        .where({ job_id: DRILL_JOB_ID })
        .where('progress', 'like', '%"claim":{%')
        .orderBy('id', 'desc')
        .limit(50)
        .select('id', 'progress')) as Array<{ id: number; progress: string | null }>
      return ownsFrom(
        rows.map((x) => parseResult(x.progress)),
        scratch
      )
    }
  }
}

/** Newest claim on `scratch` (results newest first) → ours unless that run confirmed the drop. */
export function ownsFrom(results: Array<DrillResult | null>, scratch: string): boolean {
  const hit = results.find((x) => x?.claim?.scratch_db.toLowerCase() === scratch.toLowerCase())
  return !!hit && hit.dropped !== true
}

async function store(rowId: number | null, r: DrillResult): Promise<void> {
  if (rowId == null) return
  try {
    await db('nivaro_job_runs')
      .where('id', rowId)
      .update({ progress: serializeResult(r) })
  } catch {
    /* bookkeeping must never break the drill */
  }
}

/**
 * The `restore-drill` cron body (nightly tick and Run now, both through the CronManager, which
 * owns the job row, the heavy slot and the background pool). Off / cloud → returns at once and
 * records nothing. A failed drill throws so the job row reads failed; a blocked one completes
 * with its reason stored.
 */
export async function restoreDrillTick(settings: EffectiveRecovery): Promise<DrillResult | null> {
  if (settings.cloud || !settings.drill_enabled) return null
  const rowId = await ownRunRow()
  const result = await runRestoreDrill({
    dryRun: false,
    settings,
    onPhase: (r) => store(rowId, r),
    ledger: jobRunLedger(rowId)
  })
  await store(rowId, result)
  if (result.verdict === 'failed') throw new Error(`Restore drill failed: ${result.reason}`)
  return result
}

export interface DrillRunRow {
  id: number
  status: string
  started_at: string
  finished_at: string | null
  trigger: string | null
  error: string | null
  result: DrillResult | null
}

/** The drill's newest job rows with their stored results (newest first). */
export async function listDrillRuns(limit = 10): Promise<DrillRunRow[]> {
  const rows = (await db('nivaro_job_runs')
    .where({ job_id: DRILL_JOB_ID })
    .orderBy('id', 'desc')
    .limit(Math.min(50, Math.max(1, limit)))
    .select('*')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    status: String(r.status ?? ''),
    started_at: new Date(r.started_at as string).toISOString(),
    finished_at: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
    trigger: (r.trigger_kind as string | null) ?? null,
    error: r.error ? String(r.error).split('\n')[0].slice(0, 400) : null,
    result: parseResult(r.progress)
  }))
}
