import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import {
  normalizePrefs,
  normalizeRoleDefaults,
  type OverviewLayout,
  type OverviewPrefs
} from './model.js'

/**
 * Overview preferences: per person under `nivaro_users.preferences.overview` (no column of its
 * own), per role in `nivaro_settings.overview_role_defaults` (migration 522; absent before it
 * runs, which reads as "no role starters").
 */

const PREFS_KEY = 'overview'

function parsePreferences(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export async function readOverviewPrefs(userId: string): Promise<OverviewPrefs> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  return normalizePrefs(parsePreferences(row?.preferences)[PREFS_KEY])
}

/**
 * Merge a change into the person's overview preferences (read-modify-write of the whole
 * preferences JSON, like PATCH /users/me/preferences). Returns what is now stored.
 */
export async function writeOverviewPrefs(
  userId: string,
  change: (current: OverviewPrefs) => OverviewPrefs
): Promise<OverviewPrefs> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  const all = parsePreferences(row?.preferences)
  const next = normalizePrefs(change(normalizePrefs(all[PREFS_KEY])))
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify({ ...all, [PREFS_KEY]: next }) })
  return next
}

const COLUMN = 'overview_role_defaults'

export async function readRoleDefaults(): Promise<Record<string, OverviewLayout>> {
  if (!(await hasColumn('nivaro_settings', COLUMN).catch(() => false))) return {}
  const row = (await db('nivaro_settings').first(COLUMN)) as Record<string, unknown> | undefined
  return normalizeRoleDefaults(row?.[COLUMN] ?? null)
}

export async function roleDefaultFor(
  role: string | null | undefined
): Promise<OverviewLayout | null> {
  if (!role) return null
  return (await readRoleDefaults())[String(role).toUpperCase()] ?? null
}

/** Store the whole role map. False when migration 522 has not run here. */
export async function writeRoleDefaults(map: Record<string, OverviewLayout>): Promise<boolean> {
  if (!(await hasColumn('nivaro_settings', COLUMN).catch(() => false))) return false
  const clean = normalizeRoleDefaults(map)
  const value = Object.keys(clean).length ? JSON.stringify(clean) : null
  // The singleton settings row always exists (created at install); no row = nothing stored.
  const updated = await db('nivaro_settings').update({ [COLUMN]: value })
  return Number(updated) > 0
}
