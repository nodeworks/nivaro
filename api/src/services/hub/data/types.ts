/**
 * Nivaro Hub data care (migration 569): backups, restore drills, environment refreshes and move
 * rehearsals the Hub runs for its apps. Shapes shared by the services, the routes and the tests.
 *
 * The anti-goal of the Hub ("it never holds an app's data or reads its records") binds every
 * run here: a database copy is always made by the database server itself (BACKUP / RESTORE on
 * SQL Server, through the server's provisioning login), files are copied by the app itself (its
 * hub link or deployment link), and the Hub only records where things went, sizes, times and
 * row COUNTS. The one exception is a refresh's keep set: the target's own settings rows (mail,
 * keys, switches, service accounts) that must survive the copy, which the Hub holds sealed with
 * ENCRYPTION_KEY in the run row until the rollback window ends.
 */

export const DATA_RUN_KINDS = [
  'db_backup',
  'backup_seen',
  'files_backup',
  'restore_drill',
  'refresh',
  'refresh_rollback',
  'rehearsal'
] as const
export type DataRunKind = (typeof DATA_RUN_KINDS)[number]

/**
 * running → done | failed | refused | cancelled; a refresh may be `waiting` (a manual step) or
 * `interrupted` (its process went away: Resume continues, Roll back undoes).
 */
export type DataRunStatus =
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'refused'
  | 'cancelled'

export const OPEN_DATA_STATUSES: readonly DataRunStatus[] = ['running', 'waiting', 'interrupted']

export type DataStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'warn'

export interface DataStep {
  key: string
  label: string
  state: DataStepState
  started_at: string | null
  ms: number | null
  /** One sentence for people: what happened, or why it failed. Never a secret or driver dump. */
  note: string | null
}

export interface DataRun {
  id: number
  kind: DataRunKind
  environment_id: number
  source_environment_id: number | null
  status: DataRunStatus
  step: string | null
  started_via: 'person' | 'schedule'
  steps: DataStep[]
  plan: Record<string, unknown> | null
  plan_hash: string | null
  result: Record<string, unknown> | null
  artifact: Record<string, unknown> | null
  error: string | null
  started_by: string | null
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
  expires_at: string | null
  /** A refresh still holds the target's keep set (sealed): its rollback window is open. */
  holds_keep_set: boolean
}

export type DataCode =
  | 'NOT_FOUND'
  | 'BAD_POLICY'
  | 'BAD_SCHEDULE'
  | 'BAD_TARGET'
  | 'BAD_PATH'
  | 'NO_DATABASE'
  | 'DATABASE_NOT_READY'
  | 'ENGINE_NOT_SUPPORTED'
  | 'NO_SERVER_LOGIN'
  | 'SERVER_MANUAL'
  | 'DATA_BUSY'
  | 'MOVE_OPEN'
  | 'ENV_BUSY'
  | 'PRODUCTION_TARGET'
  | 'NOT_LOWER'
  | 'OTHER_APP'
  | 'SAME_DATABASE'
  | 'VERSION_MISMATCH'
  | 'VERSION_UNKNOWN'
  | 'PLAN_CHANGED'
  | 'PLAN_BLOCKED'
  | 'CONFIRM_MISMATCH'
  | 'CORE_KEEPS_ONLY'
  | 'NO_ROLLBACK'
  | 'ROLLBACK_EXPIRED'
  | 'NOT_RESUMABLE'
  | 'NO_BACKUP'
  | 'SCRATCH_TAKEN'
  | 'NOT_SHARED_TARGET'
  | 'APP_UNREACHABLE'
  | 'FILES_TARGET_MISSING'
  | 'RUN_ENDED'
  | 'LOCK_UNAVAILABLE'

export class DataError extends Error {
  code: DataCode
  status: number
  extra: Record<string, unknown> | undefined
  constructor(code: DataCode, message: string, status = 409, extra?: Record<string, unknown>) {
    super(message)
    this.name = 'DataError'
    this.code = code
    this.status = status
    this.extra = extra
  }
}

/** Where a files backup goes: a folder the app's host allows, or an S3 bucket. */
export type FilesTarget =
  | { kind: 'dir'; path: string }
  | { kind: 's3'; bucket: string; prefix: string; region: string | null; endpoint: string | null }

export interface BackupPolicy {
  environment_id: number
  db_enabled: boolean
  /** Cron expression (5 fields), in UTC. */
  db_schedule: string | null
  /** Folder on the database server (or a UNC share it can write); null = its default folder. */
  db_path: string | null
  db_keep_days: number | null
  db_keep_count: number | null
  db_verify: boolean
  files_enabled: boolean
  files_schedule: string | null
  files_target: FilesTarget | null
  /** S3 access key + secret, only ever the mask on the way out. */
  target_secret: string | null
  files_keep_count: number | null
  drill_enabled: boolean
  drill_schedule: string | null
  drill_checkdb: boolean
  notes: string | null
  updated_at: string | null
}
