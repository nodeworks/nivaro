import { db } from '../db/index.js'
import { isMultiTenant } from './deployment-mode.js'
import { encryptValue } from './encryption.js'

/**
 * Mail settings from the server environment kept for a move to a Hub shared deployment (0.3.215).
 *
 * A dedicated app may send mail with the server's `SMTP_*` / `MAIL_FROM` (or a per-instance
 * override row) and nothing saved in Settings → Email. A shared deployment's environment is the
 * deployment's, never the app's, so after a move such an app would send through the
 * deployment's relay, or not at all. When the Hub puts the source in maintenance for a move to a
 * shared deployment it asks (`keep_env_mail`, routes/hub-link.ts); the source then writes the
 * mail settings it uses right now into its own settings row (the same database the shared
 * deployment serves), so the app keeps its own relay, sign-in and sender after the move:
 *
 *  - only when nothing is saved: an empty smtp_host. A saved host means Settings → Email already
 *    drives mail, and it is never overwritten;
 *  - only empty columns are filled (a saved sender, port or security switch stays);
 *  - the password is sealed with the app's own key (enc:v1, the key the shared deployment opens
 *    it with) when the app has one, else stored as Settings → Email stores it (plain);
 *  - never on a multi-tenant process (there the environment is the deployment's), and nothing
 *    when the server has no relay (`localhost`, the no-mail default).
 *
 * Idempotent: a second call finds the host saved and does nothing. A rollback leaves the values
 * in place: they are what the app was already sending with, so its mail does not change.
 */

export interface KeptMail {
  kept: boolean
  /** Columns written (names only, never values). */
  fields: string[]
}

const COLUMNS = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'smtp_secure'
] as const

const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')

/** What to write (pure): the effective values for every empty saved column. */
export function mailColumnsToKeep(
  saved: Record<string, unknown> | undefined,
  effective: {
    host: string
    port: number
    secure: boolean
    user: string | null
    pass: string | null
    from: string
  }
): Record<string, unknown> | null {
  const host = (effective.host ?? '').trim()
  if (!saved || !blank(saved.smtp_host) || !host || host === 'localhost') return null
  const want: Record<string, unknown> = {
    smtp_host: host,
    smtp_port: effective.port,
    smtp_user: effective.user,
    smtp_pass: effective.pass,
    smtp_from: effective.from,
    smtp_secure: effective.secure
  }
  const out: Record<string, unknown> = {}
  for (const c of COLUMNS) if (blank(saved[c]) && !blank(want[c])) out[c] = want[c]
  return out
}

/** Sealed with the app's key when it has one (a move to shared needs it), else plain. */
function sealIfKeyed(pass: string): string {
  const key = (process.env.ENCRYPTION_KEY ?? '').trim()
  return /^[0-9a-fA-F]{64}$/.test(key) ? encryptValue(pass) : pass
}

/** Writes the mail settings this app uses now into its own settings row (see above). */
export async function keepEnvMailSettings(): Promise<KeptMail> {
  if (isMultiTenant()) return { kept: false, fields: [] }
  const present: string[] = []
  for (const c of COLUMNS)
    if (await db.schema.hasColumn('nivaro_settings', c).catch(() => false)) present.push(c)
  if (!present.includes('smtp_host')) return { kept: false, fields: [] }
  const row = (await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('id', ...present)) as (Record<string, unknown> & { id: number }) | undefined
  if (!row) return { kept: false, fields: [] }
  const { getSmtpConfig } = await import('./mail.js')
  const effective = await getSmtpConfig()
  const write = mailColumnsToKeep(row, effective)
  if (!write) return { kept: false, fields: [] }
  for (const k of Object.keys(write)) if (!present.includes(k)) delete write[k]
  if (typeof write.smtp_pass === 'string') write.smtp_pass = sealIfKeyed(write.smtp_pass)
  const fields = Object.keys(write).sort()
  if (!fields.length) return { kept: false, fields: [] }
  await db('nivaro_settings').where({ id: row.id }).update(write)
  try {
    const { logActivity } = await import('./activity.js')
    await logActivity({
      action: 'update',
      user: null,
      collection: 'nivaro_settings',
      item: String(row.id),
      origin: 'machine',
      comment: `Mail settings from the server environment saved in Settings → Email for a move to a shared deployment (${fields.join(', ')})`
    })
  } catch {
    /* the activity row is best effort; the settings are written */
  }
  return { kept: true, fields }
}
