import { db } from '../../../db/index.js'
import { HUB_MASK, nextSecret, openSecret } from '../secrets.js'

/**
 * Hub security settings.
 *
 * Hub-wide (one `nivaro_extension_settings` row, extension 'nivaro-core', key `hub_security`,
 * JSON; no migration): the image scanner endpoint (URL + sealed token — no outbound call is ever
 * made while no URL is set), the break-glass longest grant, and the TLS watch switch.
 *
 * Per app (nivaro_hub_security_settings): how often an access review starts by itself (0 = never,
 * else every 1–12 months) and how many days owners have to finish it.
 *
 * Written only by admins (routes/hub-security.ts, logged).
 */

export const SECURITY_EXT = 'nivaro-core'
export const SECURITY_KEY = 'hub_security'
export const PER_APP = 'nivaro_hub_security_settings'

export interface SecuritySettings {
  scanner_url: string | null
  /** Sealed (services/hub/secrets.ts); answered masked. */
  scanner_token: string | null
  /** Longest break-glass grant a request may ask for (1–24). */
  break_glass_max_hours: number
  tls_watch: boolean
}

export const DEFAULT_SETTINGS: SecuritySettings = {
  scanner_url: null,
  scanner_token: null,
  break_glass_max_hours: 8,
  tls_watch: true
}

/**
 * An https URL (or plain http to this machine) with no credentials; null when unusable. A
 * scanner on this machine or a private address is reached only when SSRF_ALLOW_HOSTS names it
 * (the call goes through safeFetch).
 */
export function scannerUrlCheck(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const u = new URL(v.trim())
    if (u.username || u.password) return null
    if (u.protocol === 'https:') return u.toString().replace(/\/+$/, '')
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
      return u.toString().replace(/\/+$/, '')
    return null
  } catch {
    return null
  }
}

function fromJson(raw: unknown): SecuritySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const r = raw as Record<string, unknown>
  const hours = Number(r.break_glass_max_hours)
  return {
    scanner_url: scannerUrlCheck(r.scanner_url),
    scanner_token: typeof r.scanner_token === 'string' && r.scanner_token ? r.scanner_token : null,
    break_glass_max_hours:
      Number.isInteger(hours) && hours >= 1 && hours <= 24
        ? hours
        : DEFAULT_SETTINGS.break_glass_max_hours,
    tls_watch: r.tls_watch !== false
  }
}

export async function loadSecuritySettings(): Promise<SecuritySettings> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: SECURITY_EXT, key: SECURITY_KEY })
      .first('value')) as { value: string | null } | undefined
    return row?.value ? fromJson(JSON.parse(row.value)) : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** What GET answers: the token masked. */
export function publicSettings(s: SecuritySettings) {
  return { ...s, scanner_token: s.scanner_token ? HUB_MASK : null }
}

export class SettingsError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}

/** Validates an edit against the stored settings (the mask keeps the stored token). */
export function nextSettings(body: unknown, stored: SecuritySettings): SecuritySettings {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const out = { ...stored }
  if ('scanner_url' in b) {
    if (b.scanner_url == null || b.scanner_url === '') out.scanner_url = null
    else {
      const url = scannerUrlCheck(b.scanner_url)
      if (!url)
        throw new SettingsError(
          'BAD_SCANNER_URL',
          'The scanner URL must be https (plain http only to localhost) without a user or password.'
        )
      out.scanner_url = url
    }
  }
  if ('scanner_token' in b) {
    const t = b.scanner_token
    if (t != null && typeof t !== 'string')
      throw new SettingsError('BAD_SCANNER_TOKEN', 'The scanner token must be text.')
    if (typeof t === 'string' && t !== HUB_MASK && t.length > 4096)
      throw new SettingsError('BAD_SCANNER_TOKEN', 'The scanner token is too long.')
    out.scanner_token = nextSecret(t ?? '', stored.scanner_token)
  }
  if ('break_glass_max_hours' in b) {
    const h = Number(b.break_glass_max_hours)
    if (!Number.isInteger(h) || h < 1 || h > 24)
      throw new SettingsError('BAD_HOURS', 'The longest grant is 1 to 24 hours.')
    out.break_glass_max_hours = h
  }
  if ('tls_watch' in b) out.tls_watch = b.tls_watch !== false
  // A token never follows its scanner to another place (L1): a changed or cleared URL drops
  // the stored token unless this same edit gives a new one.
  const origin = (u: string | null) => {
    try {
      return u ? new URL(u).origin : null
    } catch {
      return null
    }
  }
  const newToken =
    'scanner_token' in b &&
    typeof b.scanner_token === 'string' &&
    b.scanner_token !== HUB_MASK &&
    b.scanner_token !== ''
  if (origin(out.scanner_url) !== origin(stored.scanner_url) && !newToken) out.scanner_token = null
  return out
}

export async function saveSecuritySettings(s: SecuritySettings): Promise<void> {
  const where = { extension_id: SECURITY_EXT, key: SECURITY_KEY }
  const value = JSON.stringify(s)
  const existing = (await db('nivaro_extension_settings').where(where).first('id')) as
    | { id: number }
    | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else await db('nivaro_extension_settings').insert({ ...where, value, updated_at: new Date() })
}

/** The scanner endpoint and its plain token, or null when no URL is set (no call is made). */
export async function scannerEndpoint(
  s?: SecuritySettings
): Promise<{ url: string; token: string | null } | null> {
  const settings = s ?? (await loadSecuritySettings())
  if (!settings.scanner_url) return null
  return { url: settings.scanner_url, token: openSecret(settings.scanner_token) }
}

// ─── Per app: access review cadence ─────────────────────────────────────────────────────────

export interface AppSecuritySettings {
  app_id: number
  review_every_months: number
  review_due_days: number
  next_review_at: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

export async function readAppSecurity(appId: number): Promise<AppSecuritySettings> {
  const r = (await db(PER_APP).where({ app_id: appId }).first()) as
    | Record<string, unknown>
    | undefined
  return {
    app_id: appId,
    review_every_months: Number(r?.review_every_months ?? 0),
    review_due_days: Number(r?.review_due_days ?? 14),
    next_review_at: iso(r?.next_review_at)
  }
}

/** The first of the month `months` after `from`, 13:00 UTC (a weekday morning in the Americas). */
export function nextReviewAfter(from: Date, months: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1, 13))
  return d
}

export async function saveAppSecurity(
  appId: number,
  body: unknown,
  userId: string,
  now = new Date()
): Promise<AppSecuritySettings> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const every = Number(b.review_every_months)
  const due = Number(b.review_due_days ?? 14)
  if (!Number.isInteger(every) || every < 0 || every > 12)
    throw new SettingsError('BAD_CADENCE', 'Every 0 (off) to 12 months.')
  if (!Number.isInteger(due) || due < 1 || due > 90)
    throw new SettingsError('BAD_DUE_DAYS', 'Owners get 1 to 90 days to finish a review.')
  const current = await readAppSecurity(appId)
  // A changed cadence restarts the clock from now; an unchanged one keeps its next date.
  const next =
    every === 0
      ? null
      : every === current.review_every_months && current.next_review_at
        ? new Date(current.next_review_at)
        : nextReviewAfter(now, every)
  const row = {
    review_every_months: every,
    review_due_days: due,
    next_review_at: next,
    updated_by: userId,
    updated_at: now
  }
  const n = await db(PER_APP).where({ app_id: appId }).update(row)
  if (!n) await db(PER_APP).insert({ app_id: appId, ...row })
  return readAppSecurity(appId)
}
