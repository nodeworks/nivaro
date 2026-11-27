import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { appSettingAllowed } from './settings-allow.js'

/**
 * Hub providers (Task 13), APP side: `POST settings/apply {settings: {key: value}}` on the hub link
 * (a dedicated app) and the deployment link (one app of a shared deployment). Writes only the
 * allow-listed keys (settings-allow.ts); one key outside it refuses the WHOLE request (400
 * SETTING_NOT_ALLOWED, nothing written). Values are never logged: the activity row names the keys.
 *
 *   huddle_livekit_url / _key / _secret   the huddle settings (instance overrides, sealed where the
 *                                         app seals them) — services/huddle-settings.ts
 *   everything else                       the nivaro_settings column of that name; a column this
 *                                         app does not have answers 409 SETTING_NOT_ON_THIS_APP
 */

export type SettingsApplyOutcome =
  | { ok: true; applied: string[] }
  | { ok: false; status: number; code: string; message: string; keys?: string[] }

const MAX_KEYS = 40
const MAX_VALUE = 8000

const HUDDLE: Record<string, 'livekit_url' | 'livekit_api_key' | 'livekit_api_secret'> = {
  huddle_livekit_url: 'livekit_url',
  huddle_livekit_key: 'livekit_api_key',
  huddle_livekit_secret: 'livekit_api_secret'
}

const refuse = (status: number, code: string, message: string, keys?: string[]) =>
  ({ ok: false, status, code, message, ...(keys ? { keys } : {}) }) as const

export async function applyHubSettings(
  body: unknown,
  deps: { k?: Knex } = {}
): Promise<SettingsApplyOutcome> {
  const k = deps.k ?? db
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null
  const raw = (b as { settings?: unknown } | null)?.settings
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return refuse(400, 'BAD_REQUEST', 'settings must be an object of text values')
  const entries = Object.entries(raw as Record<string, unknown>)
  if (!entries.length) return refuse(400, 'BAD_REQUEST', 'settings names no setting')
  if (entries.length > MAX_KEYS)
    return refuse(400, 'BAD_REQUEST', `At most ${MAX_KEYS} settings at once`)
  const notAllowed = entries.map(([key]) => key).filter((key) => !appSettingAllowed(key))
  if (notAllowed.length)
    return refuse(
      400,
      'SETTING_NOT_ALLOWED',
      `The Hub may not set ${notAllowed.slice(0, 10).join(', ')} on this app`,
      notAllowed.slice(0, 40)
    )
  const columns: Record<string, unknown> = {}
  const huddle: Record<string, string | null> = {}
  for (const [key, v] of entries) {
    if (v !== null && typeof v !== 'string')
      return refuse(400, 'BAD_VALUE', `${key} must be text or null`, [key])
    if (typeof v === 'string' && v.length > MAX_VALUE)
      return refuse(400, 'BAD_VALUE', `${key} is longer than ${MAX_VALUE} characters`, [key])
    if (HUDDLE[key]) {
      huddle[HUDDLE[key]] = v === '' ? null : v
      continue
    }
    if (key === 'smtp_port' && v !== null && v !== '') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        return refuse(400, 'BAD_VALUE', 'smtp_port must be a port number', [key])
      columns[key] = n
      continue
    }
    columns[key] = v === '' ? null : v
  }
  if (Object.keys(columns).length) {
    const have = await k('nivaro_settings').columnInfo()
    const missing = Object.keys(columns).filter((c) => !(c in have))
    if (missing.length)
      return refuse(
        409,
        'SETTING_NOT_ON_THIS_APP',
        `This app has no ${missing.join(', ')} setting (an older Nivaro version?)`,
        missing
      )
    let row = (await k('nivaro_settings').orderBy('id', 'asc').first('id')) as
      | { id: number }
      | undefined
    if (!row) {
      await k('nivaro_settings').insert({ updated_at: new Date() })
      row = (await k('nivaro_settings').orderBy('id', 'asc').first('id')) as { id: number }
    }
    await k('nivaro_settings')
      .where({ id: row.id })
      .update({ ...columns, updated_at: new Date() })
    await logActivity({
      action: 'update',
      user: null,
      collection: 'nivaro_settings',
      item: String(row.id),
      comment: `Set by the Nivaro Hub: ${Object.keys(columns).join(', ')}`,
      origin: 'integration'
    }).catch(() => null)
  }
  if (Object.keys(huddle).length) {
    const { bustHuddleSettingsCache, saveHuddleSettings } = await import('../huddle-settings.js')
    await saveHuddleSettings(huddle)
    bustHuddleSettingsCache()
  }
  return { ok: true, applied: entries.map(([key]) => key) }
}
