import { Cron } from 'croner'
import { db } from '../../../db/index.js'
import { HUB_MASK, MASK_CHAR, openSecret, sealSecret } from '../secrets.js'
import { hasControlChar, isServerFolder } from './mssql-sql.js'
import { type BackupPolicy, DataError, type FilesTarget } from './types.js'

/**
 * Per-environment backup policy (nivaro_hub_backup_policies): when the Hub backs up the
 * database, where it puts the files copy, how long it keeps each and when it runs a restore
 * drill. Schedules are 5-field cron expressions in UTC, at least an hour apart.
 *
 * The S3 key pair of a files target is sealed (`target_secret`, ENCRYPTION_KEY) and only ever
 * answered as the mask; sending the mask back keeps it, null clears it.
 */

const TABLE = 'nivaro_hub_backup_policies'
const MIN_GAP_MS = 60 * 60_000
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const PREFIX_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/
const REGION_RE = /^[a-z0-9-]{1,40}$/

export const DEFAULT_DB_KEEP_COUNT = 7
export const DEFAULT_FILES_KEEP_COUNT = 3

const has = (o: Record<string, unknown>, k: string) => Object.hasOwn(o, k)
const bool = (v: unknown) => v === true || v === 1 || v === '1'

function fail(message: string, code: 'BAD_POLICY' | 'BAD_SCHEDULE' | 'BAD_PATH' = 'BAD_POLICY') {
  return new DataError(code, message, 400)
}

/** A 5-field cron expression whose runs are at least an hour apart (UTC), or a refusal. */
export function checkSchedule(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim())
    throw fail(`${what}: a schedule (cron, 5 fields, UTC) is required.`, 'BAD_SCHEDULE')
  const expr = v.trim().replace(/\s+/g, ' ')
  if (expr.split(' ').length !== 5 || expr.length > 120)
    throw fail(
      `${what}: the schedule must be a 5-field cron expression (minute hour day month weekday).`,
      'BAD_SCHEDULE'
    )
  let c: Cron
  try {
    c = new Cron(expr, { paused: true, timezone: 'UTC' })
  } catch {
    throw fail(`${what}: "${expr}" is not a cron expression.`, 'BAD_SCHEDULE')
  }
  // A year of runs (capped): a schedule that is an hour apart most days but not on some is refused.
  const runs = c.nextRuns(400, new Date(Date.UTC(2030, 0, 1)))
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_GAP_MS)
      throw fail(`${what}: runs must be at least an hour apart.`, 'BAD_SCHEDULE')
  }
  if (!runs.length) throw fail(`${what}: "${expr}" never runs.`, 'BAD_SCHEDULE')
  return expr
}

/** The next run of `schedule` after `after` (UTC), or null when it never runs again. */
export function nextRunAfter(schedule: string, after: Date): Date | null {
  try {
    return new Cron(schedule, { paused: true, timezone: 'UTC' }).nextRun(after) ?? null
  } catch {
    return null
  }
}

/**
 * A scheduled run is due when the schedule's first time after the last run of that kind (or,
 * with none yet, after the policy was saved) has passed.
 */
export function isDue(
  schedule: string | null,
  last: Date | null,
  anchor: Date,
  now: Date
): boolean {
  if (!schedule) return false
  const next = nextRunAfter(schedule, last ?? anchor)
  return !!next && next.getTime() <= now.getTime()
}

function intIn(v: unknown, min: number, max: number, what: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw fail(`${what} must be a whole number from ${min} to ${max}.`)
  return n
}

/** A folder on the app's host for a files backup: absolute, no `..`, no control characters. */
export function isHostFolder(v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (!v || v.length > 400 || v.trim() !== v) return false
  if (/["'`;]/.test(v) || hasControlChar(v)) return false
  if (/(^|[\\/])\.\.([\\/]|$)/.test(v)) return false
  return /^\/[^/]/.test(v) || /^[A-Za-z]:\\/.test(v)
}

export function checkFilesTarget(v: unknown): FilesTarget {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw fail('files_target must be {kind: "dir", path} or {kind: "s3", bucket, prefix, …}.')
  const o = v as Record<string, unknown>
  if (o.kind === 'dir') {
    if (!isHostFolder(o.path))
      throw fail(
        'The files backup folder must be an absolute path on the app’s host (no "..").',
        'BAD_PATH'
      )
    return { kind: 'dir', path: o.path }
  }
  if (o.kind === 's3') {
    if (typeof o.bucket !== 'string' || !BUCKET_RE.test(o.bucket))
      throw fail('The bucket must be an S3 bucket name (lowercase letters, digits, dots, dashes).')
    const prefix = typeof o.prefix === 'string' ? o.prefix.trim().replace(/^\/+|\/+$/g, '') : ''
    if (prefix && (!PREFIX_RE.test(prefix) || prefix.length > 200 || prefix.includes('..')))
      throw fail('The prefix may hold letters, digits, dots, dashes, underscores and slashes.')
    const region =
      o.region === undefined || o.region === null || o.region === '' ? null : String(o.region)
    if (region !== null && !REGION_RE.test(region)) throw fail('The region is not a region name.')
    let endpoint: string | null = null
    if (o.endpoint !== undefined && o.endpoint !== null && o.endpoint !== '') {
      try {
        const u = new URL(String(o.endpoint))
        if (
          u.protocol !== 'https:' ||
          u.username ||
          u.password ||
          (u.pathname && u.pathname !== '/')
        )
          throw new Error('bad')
        endpoint = u.origin
      } catch {
        throw fail('The endpoint must be an https address with no path (an S3-compatible store).')
      }
    }
    return { kind: 's3', bucket: o.bucket, prefix, region, endpoint }
  }
  throw fail('files_target.kind must be dir or s3.')
}

/** `{access_key_id, secret_access_key}` sealed; the mask keeps; null clears. */
function nextTargetSecret(incoming: unknown, stored: string | null): string | null {
  if (incoming === undefined || incoming === HUB_MASK) return stored
  if (incoming === null || incoming === '') return null
  if (typeof incoming !== 'object' || Array.isArray(incoming))
    throw fail('target_secret must be {access_key_id, secret_access_key}.')
  const o = incoming as Record<string, unknown>
  const a = o.access_key_id
  const s = o.secret_access_key
  if (a === HUB_MASK && s === HUB_MASK) return stored
  const masked = (x: unknown) => typeof x === 'string' && x.includes(MASK_CHAR)
  if (masked(a) || masked(s))
    throw fail('Send both halves of the key again, or neither: one of them is still the mask.')
  if (
    typeof a !== 'string' ||
    !a.trim() ||
    a.length > 200 ||
    typeof s !== 'string' ||
    !s ||
    s.length > 400
  )
    throw fail('The S3 key needs an access key id and a secret access key.')
  return sealSecret(JSON.stringify({ access_key_id: a.trim(), secret_access_key: s }))
}

/** The sealed S3 key pair, opened for one call (never logged or answered). */
export function openTargetSecret(
  stored: string | null
): { access_key_id: string; secret_access_key: string } | null {
  const plain = openSecret(stored)
  if (!plain) return null
  const o = JSON.parse(plain) as Record<string, unknown>
  if (typeof o.access_key_id !== 'string' || typeof o.secret_access_key !== 'string') return null
  return { access_key_id: o.access_key_id, secret_access_key: o.secret_access_key }
}

function parseTarget(raw: unknown): FilesTarget | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    return checkFilesTarget(typeof raw === 'string' ? JSON.parse(raw) : raw)
  } catch {
    return null
  }
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/** A stored row as the services read it (`target_secret` still sealed). */
export function policyFromRow(r: Record<string, unknown>): BackupPolicy {
  return {
    environment_id: Number(r.environment_id),
    db_enabled: bool(r.db_enabled),
    db_schedule: (r.db_schedule as string | null) ?? null,
    db_path: (r.db_path as string | null) ?? null,
    db_keep_days: numOrNull(r.db_keep_days),
    db_keep_count: numOrNull(r.db_keep_count),
    db_verify: r.db_verify === undefined || r.db_verify === null ? true : bool(r.db_verify),
    files_enabled: bool(r.files_enabled),
    files_schedule: (r.files_schedule as string | null) ?? null,
    files_target: parseTarget(r.files_target),
    target_secret: (r.target_secret as string | null) ?? null,
    files_keep_count: numOrNull(r.files_keep_count),
    drill_enabled: bool(r.drill_enabled),
    drill_schedule: (r.drill_schedule as string | null) ?? null,
    drill_checkdb: bool(r.drill_checkdb),
    notes: (r.notes as string | null) ?? null,
    updated_at: iso(r.updated_at)
  }
}

/** What a person sees: the S3 key pair only ever as the mask. */
export function publicPolicy(p: BackupPolicy): BackupPolicy {
  return { ...p, target_secret: p.target_secret ? HUB_MASK : null }
}

export function emptyPolicy(envId: number): BackupPolicy {
  return {
    environment_id: envId,
    db_enabled: false,
    db_schedule: null,
    db_path: null,
    db_keep_days: null,
    db_keep_count: null,
    db_verify: true,
    files_enabled: false,
    files_schedule: null,
    files_target: null,
    target_secret: null,
    files_keep_count: null,
    drill_enabled: false,
    drill_schedule: null,
    drill_checkdb: false,
    notes: null,
    updated_at: null
  }
}

/** Validates an edit over the stored policy (keys left out keep their stored value). */
export function validatePolicy(
  body: Record<string, unknown>,
  stored: BackupPolicy
): Omit<BackupPolicy, 'updated_at'> {
  const pick = <K extends keyof BackupPolicy>(k: K): unknown => (has(body, k) ? body[k] : stored[k])
  const db_enabled = bool(pick('db_enabled'))
  const files_enabled = bool(pick('files_enabled'))
  const drill_enabled = bool(pick('drill_enabled'))
  const sched = (
    k: 'db_schedule' | 'files_schedule' | 'drill_schedule',
    on: boolean,
    what: string
  ) => {
    const v = pick(k)
    if (!on && (v === null || v === undefined || v === '')) return null
    return checkSchedule(v, what)
  }
  const dbPathRaw = pick('db_path')
  let db_path: string | null = null
  if (dbPathRaw !== null && dbPathRaw !== undefined && dbPathRaw !== '') {
    if (!isServerFolder(dbPathRaw))
      throw fail(
        'The backup folder must be a folder on the database server: X:\\…, \\\\server\\share\\… or /… (no quotes or "..").',
        'BAD_PATH'
      )
    db_path = dbPathRaw
  }
  const targetRaw = pick('files_target')
  const files_target =
    targetRaw === null || targetRaw === undefined || targetRaw === ''
      ? null
      : checkFilesTarget(targetRaw)
  if (files_enabled && !files_target)
    throw fail('A files backup needs a target: a folder on the app’s host or an S3 bucket.')
  const target_secret =
    files_target?.kind === 's3' ? nextTargetSecret(body.target_secret, stored.target_secret) : null
  if (files_enabled && files_target?.kind === 's3' && !target_secret)
    throw fail('An S3 files target needs its access key id and secret access key.')
  const notes = pick('notes')
  if (notes !== null && notes !== undefined && (typeof notes !== 'string' || notes.length > 1000))
    throw fail('Notes must be text of at most 1000 characters.')
  return {
    environment_id: stored.environment_id,
    db_enabled,
    db_schedule: sched('db_schedule', db_enabled, 'Database backups'),
    db_path,
    db_keep_days: intIn(pick('db_keep_days'), 1, 3650, 'Days to keep database backups'),
    db_keep_count: intIn(pick('db_keep_count'), 1, 1000, 'Database backups to keep'),
    db_verify: pick('db_verify') === undefined ? true : bool(pick('db_verify')),
    files_enabled,
    files_schedule: sched('files_schedule', files_enabled, 'Files backups'),
    files_target,
    target_secret,
    files_keep_count: intIn(pick('files_keep_count'), 1, 100, 'Files backups to keep'),
    drill_enabled,
    drill_schedule: sched('drill_schedule', drill_enabled, 'Restore drills'),
    drill_checkdb: bool(pick('drill_checkdb')),
    notes: typeof notes === 'string' ? notes.trim() || null : null
  }
}

export async function readPolicy(envId: number): Promise<BackupPolicy> {
  const r = (await db(TABLE).where({ environment_id: envId }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? policyFromRow(r) : emptyPolicy(envId)
}

export async function listPolicies(): Promise<BackupPolicy[]> {
  const rows = (await db(TABLE).select('*')) as Record<string, unknown>[]
  return rows.map(policyFromRow)
}

export async function savePolicy(
  p: Omit<BackupPolicy, 'updated_at'>,
  by: string | null
): Promise<BackupPolicy> {
  const now = new Date()
  const cols = {
    db_enabled: p.db_enabled,
    db_schedule: p.db_schedule,
    db_path: p.db_path,
    db_keep_days: p.db_keep_days,
    db_keep_count: p.db_keep_count,
    db_verify: p.db_verify,
    files_enabled: p.files_enabled,
    files_schedule: p.files_schedule,
    files_target: p.files_target ? JSON.stringify(p.files_target) : null,
    target_secret: p.target_secret,
    files_keep_count: p.files_keep_count,
    drill_enabled: p.drill_enabled,
    drill_schedule: p.drill_schedule,
    drill_checkdb: p.drill_checkdb,
    notes: p.notes,
    updated_by: by && /^[0-9a-f-]{36}$/i.test(by) ? by : null,
    updated_at: now
  }
  const exists = await db(TABLE).where({ environment_id: p.environment_id }).first('id')
  if (exists) await db(TABLE).where({ environment_id: p.environment_id }).update(cols)
  else await db(TABLE).insert({ environment_id: p.environment_id, ...cols, created_at: now })
  return { ...p, updated_at: now.toISOString() }
}
