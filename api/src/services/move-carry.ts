import { db } from '../db/index.js'
import { isMultiTenant } from './deployment-mode.js'
import { encryptValue, isEncrypted } from './encryption.js'
import { instanceKey } from './instance-key.js'
import { parseInstanceData, readInstanceRow } from './instance-row.js'

/**
 * What a dedicated app carries across when the Hub moves it to a shared deployment (0.3.215),
 * done by the source itself in the Hub's maintenance call (routes/hub-link.ts), while it is frozen:
 *
 * 1. Its per-instance settings row. Settings → This instance, huddle media servers, the
 *    outside-write watcher, the daily report, caches … live in `nivaro_settings_overrides` under
 *    the instance key (NIVARO_INSTANCE). On the shared deployment the same database is read under
 *    the deployment's key, which the Hub passes (`target_instance`). The source copies ITS OWN row
 *    (by its own key, never another environment's) to a row keyed by the target: created when
 *    absent; when one exists already (a retried move, an earlier save there), only keys it lacks
 *    or holds empty are filled, and the keys whose values differ are reported (names only).
 *
 * 2. The mail settings it takes from its server environment (`keep_env_mail`): SMTP_* /
 *    MAIL_FROM, NIVARO_SETTINGS_OVERRIDES mail keys, and a mail test mode the environment forces
 *    (MAIL_TEST_MODE / MAIL_TEST_RECIPIENT: a staging app stays in test mode). They go into the
 *    TARGET instance row — never the database-wide nivaro_settings row other instances read —
 *    and only where neither the saved settings nor the carried row already hold a value. The
 *    password is sealed with the app's key when it has one.
 *
 * Errors throw (the route answers 503 and the move stops before maintenance). A rollback leaves
 * the source row untouched: only the target-keyed row is written. Never on a multi-tenant process.
 */

const TABLE = 'nivaro_settings_overrides'
const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/

export interface CarriedRow {
  /** created: the target row was made; filled: it existed and got keys; same: nothing to add;
   *  none: the source has no row of its own. */
  result: 'created' | 'filled' | 'same' | 'none'
  /** Keys written (names only). */
  keys: string[]
  /** Keys the target row already held with another value (kept as they were; names only). */
  differed: string[]
}

export interface KeptMail {
  /** kept: values written; none_needed: no relay from the environment, or everything saved. */
  env_mail: 'kept' | 'none_needed'
  fields: string[]
}

export const validTargetInstance = (v: unknown): v is string =>
  typeof v === 'string' && KEY_RE.test(v)

const blank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Merge the source row into the target row's data (pure): fill absent or empty keys only. */
export function mergeCarried(
  source: Record<string, unknown>,
  target: Record<string, unknown>
): { data: Record<string, unknown>; keys: string[]; differed: string[] } {
  const data = { ...target }
  const keys: string[] = []
  const differed: string[] = []
  for (const [k, v] of Object.entries(source)) {
    if (blank(v)) continue
    if (blank(target[k])) {
      data[k] = v
      keys.push(k)
    } else if (!same(target[k], v)) differed.push(k)
  }
  return { data, keys: keys.sort(), differed: differed.sort() }
}

async function readTargetRow(key: string) {
  return (await db(TABLE).where({ instance_key: key }).orderBy('id', 'asc').first('id', 'data')) as
    | { id: number; data?: unknown }
    | undefined
}

async function writeTarget(
  target: string,
  existing: { id: number } | undefined,
  data: Record<string, unknown>
): Promise<void> {
  if (existing)
    await db(TABLE)
      .where({ id: existing.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  else
    await db(TABLE).insert({
      instance_key: target,
      data: JSON.stringify(data),
      updated_at: new Date()
    })
}

/** 1. Copy this instance's own row to the row keyed `target` (see above). */
export async function carryInstanceRow(target: string): Promise<CarriedRow> {
  if (isMultiTenant()) throw new Error('not on a multi-tenant process')
  if (!validTargetInstance(target)) throw new Error('bad target instance')
  const own = instanceKey()
  if (target === own) return { result: 'same', keys: [], differed: [] }
  const mine = await readInstanceRow(own)
  if (!mine) return { result: 'none', keys: [], differed: [] }
  const existing = await readTargetRow(target)
  const { data, keys, differed } = mergeCarried(
    mine.data,
    existing ? parseInstanceData(existing.data) : {}
  )
  if (!existing) {
    await writeTarget(target, undefined, data)
    return { result: 'created', keys, differed }
  }
  if (keys.length) await writeTarget(target, existing, data)
  return { result: keys.length ? 'filled' : 'same', keys, differed }
}

const SMTP_KEYS = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'smtp_secure'
] as const
const on = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/**
 * The mail values to write (pure): what this app sends with now (`effective`, its environment
 * included) for every key that neither its saved settings + own instance row (`saved`) nor the
 * target row (`target`) holds. Nothing without a relay; test mode only when the environment
 * forces it on.
 */
export function mailToKeep(
  saved: Record<string, unknown>,
  target: Record<string, unknown>,
  effective: {
    host: string
    port: number
    secure: boolean
    user: string | null
    pass: string | null
    from: string
    testMode: boolean
    testRecipient: string | null
  }
): Record<string, unknown> {
  const host = (effective.host ?? '').trim()
  if (!host || host === 'localhost') return {}
  const want: Record<(typeof SMTP_KEYS)[number], unknown> = {
    smtp_host: host,
    smtp_port: effective.port,
    smtp_user: effective.user,
    smtp_pass: effective.pass,
    smtp_from: effective.from,
    smtp_secure: effective.secure
  }
  const out: Record<string, unknown> = {}
  for (const k of SMTP_KEYS)
    if (blank(saved[k]) && blank(target[k]) && !blank(want[k])) out[k] = want[k]
  // Test mode forced by the environment (MAIL_TEST_MODE): saved on, with the recipient it used.
  if (effective.testMode && !on(saved.mail_test_mode) && !on(target.mail_test_mode)) {
    out.mail_test_mode = true
    if (blank(target.mail_test_recipient) && !blank(effective.testRecipient))
      out.mail_test_recipient = effective.testRecipient
  }
  return out
}

/** Sealed with the app's key when it has one (a move to shared needs it), else plain. */
function sealIfKeyed(pass: string): string {
  if (isEncrypted(pass)) return pass
  const key = (process.env.ENCRYPTION_KEY ?? '').trim()
  return /^[0-9a-fA-F]{64}$/.test(key) ? encryptValue(pass) : pass
}

/** 2. Keep the environment's mail settings in the row keyed `target` (see above). */
export async function keepEnvMail(target: string): Promise<KeptMail> {
  if (isMultiTenant()) throw new Error('not on a multi-tenant process')
  if (!validTargetInstance(target)) throw new Error('bad target instance')
  const base = (await db('nivaro_settings').orderBy('id', 'asc').first()) as
    | Record<string, unknown>
    | undefined
  const mine = await readInstanceRow()
  const saved = { ...(base ?? {}), ...(mine?.data ?? {}) }
  const existing = await readTargetRow(target)
  const targetData = existing ? parseInstanceData(existing.data) : {}
  const { getSmtpConfig } = await import('./mail.js')
  const write = mailToKeep(saved, targetData, await getSmtpConfig())
  const fields = Object.keys(write).sort()
  if (!fields.length) return { env_mail: 'none_needed', fields }
  if (typeof write.smtp_pass === 'string') write.smtp_pass = sealIfKeyed(write.smtp_pass)
  await writeTarget(target, existing, { ...targetData, ...write })
  try {
    const { logActivity } = await import('./activity.js')
    await logActivity({
      action: 'update',
      user: null,
      collection: 'nivaro_settings_overrides',
      item: target,
      origin: 'machine',
      comment: `Mail settings from the server environment kept for the move to a shared deployment (${fields.join(', ')})`
    })
  } catch {
    /* the activity row is best effort; the settings are written */
  }
  return { env_mail: 'kept', fields }
}
