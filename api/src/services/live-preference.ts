import { db } from '../db/index.js'

/**
 * Live updates per-role defaults (realtime round 3, item 24). A person's own choice is
 * `nivaro_users.preferences.live_mode` (PATCH /users/me/preferences); when they never chose,
 * their role's default applies, else Normal. The role map is stored without a migration as one
 * `nivaro_extension_settings` row (extension 'nivaro-core', key `live_mode_role_defaults`,
 * value `{ "<ROLE UUID>": "calm" | "normal" | "off" }`) — configuration, so promote:config
 * carries it with the rest.
 */

export type LiveMode = 'calm' | 'normal' | 'off'
export const LIVE_EXT = 'nivaro-core'
export const LIVE_ROLE_DEFAULTS_KEY = 'live_mode_role_defaults'

const ROLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isRoleId(v: unknown): v is string {
  return typeof v === 'string' && ROLE_ID.test(v)
}

export function parseLiveMode(v: unknown): LiveMode | null {
  return v === 'calm' || v === 'normal' || v === 'off' ? v : null
}

/** Stored JSON → `{ ROLE UUID (upper): mode }`; junk reads as no defaults, never an error. */
export function parseLiveRoleDefaults(value: unknown): Record<string, LiveMode> {
  let raw: unknown = value
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, LiveMode> = {}
  for (const [role, mode] of Object.entries(raw as Record<string, unknown>)) {
    const m = parseLiveMode(mode)
    if (isRoleId(role) && m) out[role.toUpperCase()] = m
  }
  return out
}

/** One role's default, or null (= Normal). */
export function liveDefaultForRole(map: Record<string, LiveMode>, role: unknown): LiveMode | null {
  return isRoleId(role) ? (map[role.toUpperCase()] ?? null) : null
}

/** The map with one role set (a mode) or cleared (null). Pure. */
export function withRoleDefault(
  map: Record<string, LiveMode>,
  roleId: string,
  mode: LiveMode | null
): Record<string, LiveMode> {
  const next = { ...map }
  const key = roleId.toUpperCase()
  if (mode) next[key] = mode
  else delete next[key]
  return next
}

export async function loadLiveRoleDefaults(): Promise<Record<string, LiveMode>> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: LIVE_EXT, key: LIVE_ROLE_DEFAULTS_KEY })
      .first('value')) as { value: string | null } | undefined
    return parseLiveRoleDefaults(row?.value ?? null)
  } catch {
    return {}
  }
}

export async function saveLiveRoleDefaults(map: Record<string, LiveMode>): Promise<void> {
  const value = Object.keys(map).length ? JSON.stringify(map) : null
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: LIVE_EXT, key: LIVE_ROLE_DEFAULTS_KEY })
    .first('id')) as { id: number } | undefined
  if (existing) {
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  } else if (value) {
    await db('nivaro_extension_settings').insert({
      extension_id: LIVE_EXT,
      key: LIVE_ROLE_DEFAULTS_KEY,
      value,
      updated_at: new Date()
    })
  }
}
