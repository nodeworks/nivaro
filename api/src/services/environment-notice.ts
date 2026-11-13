import { db } from '../db/index.js'
import { appEnvironment } from './app-info-environment.js'
import { instanceKey } from './instance-key.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Environment notice (Rob 2026-11-13): a sign-in page — and, in the admin app, a thin edge —
 * that says "this is staging" so nobody works in a test copy thinking it is production.
 *
 * Configured per INSTANCE (each environment reads its own nivaro_settings_overrides row, key
 * `environment_notice`), edited in Settings → This Instance. `ENVIRONMENT_NOTICE=on|off` wins
 * over the stored value (a database restored from another environment carries that one's row
 * key, not this one's, so a fresh instance falls back to its default).
 *
 * Default: shown wherever the instance is not production (NIVARO_ENVIRONMENT / NIVARO_INSTANCE),
 * never on production unless an administrator turns it on there. The public answer rides
 * GET /api/app-info (no sign-in), so it carries only what the sign-in page shows.
 */

export const ENVIRONMENT_NOTICE_KEY = 'environment_notice'

export type NoticeShow = 'auto' | 'on' | 'off'

export interface EnvironmentNoticeSettings {
  /** auto = on everywhere except production. */
  show: NoticeShow
  /** Big word on the band; blank = the environment's name ("Staging"). */
  label: string | null
  /** The sentence beside it; blank = "This is a test copy. Nothing you do here reaches production." */
  message: string | null
  /** "Go to production" link; blank = NIVARO_PRODUCTION_URL. https only. */
  production_url: string | null
  /** Also mark the signed-in admin app (a tape edge along the top + the tab title). */
  in_admin_app: boolean
}

export const ENVIRONMENT_NOTICE_DEFAULTS: EnvironmentNoticeSettings = {
  show: 'auto',
  label: null,
  message: null,
  production_url: null,
  in_admin_app: true
}

/** What the sign-in page and the admin app get (null = show nothing). */
export interface EnvironmentNotice {
  label: string
  message: string
  production_url: string | null
  in_admin_app: boolean
}

const ENV_LABEL: Record<string, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  test: 'Test',
  other: 'Test environment'
}

export const DEFAULT_NOTICE_MESSAGE = 'This is a test copy. Nothing you do here reaches production.'

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

export function httpsOrigin(v: unknown): string | null {
  const t = text(v, 300)
  if (!t) return null
  try {
    const u = new URL(t)
    return u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** Stored JSON → settings (pure; anything unreadable falls back to the default). */
export function normalizeNoticeSettings(raw: unknown): EnvironmentNoticeSettings {
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    show: src.show === 'on' || src.show === 'off' ? src.show : 'auto',
    label: text(src.label, 40),
    message: text(src.message, 200),
    production_url: httpsOrigin(src.production_url),
    in_admin_app: src.in_admin_app !== false
  }
}

/** ENVIRONMENT_NOTICE=on|off, or null when unset / unreadable. */
export function noticeEnv(raw = process.env.ENVIRONMENT_NOTICE): boolean | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(v)) return true
  if (['off', 'false', '0', 'no'].includes(v)) return false
  return null
}

/** Pure: the notice this instance shows, from its settings + environment. */
export function resolveNotice(
  s: EnvironmentNoticeSettings,
  env: NodeJS.ProcessEnv = process.env
): EnvironmentNotice | null {
  if (env.CLOUD_META_DB_URL) return null
  const environment = appEnvironment(env)
  const forced = noticeEnv(env.ENVIRONMENT_NOTICE)
  const on =
    forced ?? (s.show === 'on' ? true : s.show === 'off' ? false : environment !== 'production')
  if (!on) return null
  return {
    label: s.label ?? ENV_LABEL[environment] ?? 'Test environment',
    message: s.message ?? DEFAULT_NOTICE_MESSAGE,
    production_url:
      environment === 'production'
        ? null
        : (s.production_url ?? httpsOrigin(env.NIVARO_PRODUCTION_URL)),
    in_admin_app: s.in_admin_app
  }
}

// ── Storage (30 s cache per tenant; the PATCH route busts it) ─────────────────
const cache = new Map<string, { at: number; value: EnvironmentNoticeSettings }>()

export function bustNoticeCache(): void {
  cache.clear()
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    const obj = row.data ? JSON.parse(row.data) : {}
    return { id: row.id, data: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {} }
  } catch {
    return { id: row.id, data: {} }
  }
}

export async function getNoticeSettings(): Promise<EnvironmentNoticeSettings> {
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  let value = ENVIRONMENT_NOTICE_DEFAULTS
  try {
    value = normalizeNoticeSettings((await readRow())?.data[ENVIRONMENT_NOTICE_KEY])
  } catch {
    /* table absent / DB not ready — defaults */
  }
  cache.set(tenant, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}

/** The notice for app-info (never throws). */
export async function currentNotice(): Promise<EnvironmentNotice | null> {
  try {
    return resolveNotice(await getNoticeSettings())
  } catch {
    return null
  }
}

export async function saveNoticeSettings(patch: unknown): Promise<EnvironmentNoticeSettings> {
  const row = await readRow()
  const stored = normalizeNoticeSettings(row?.data[ENVIRONMENT_NOTICE_KEY])
  const p =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  const next = normalizeNoticeSettings({
    ...stored,
    ...Object.fromEntries(
      (['show', 'label', 'message', 'production_url', 'in_admin_app'] as const)
        .filter((k) => k in p)
        .map((k) => [k, p[k]])
    )
  })
  const data = { ...(row?.data ?? {}), [ENVIRONMENT_NOTICE_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  bustNoticeCache()
  return next
}
