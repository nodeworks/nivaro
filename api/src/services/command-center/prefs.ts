import { db } from '../../db/index.js'
import { type CcLayout, readCcConfig, writeCcConfig } from './config.js'

/**
 * Command Center per-person preferences (CC-24) under `nivaro_users.preferences.command_center`
 * (no column of its own; read-modify-write of the whole preferences JSON like the Overview's).
 * Per-role starting layouts live in CcConfig.role_defaults (nivaro_settings.command_center).
 *
 * normalizeCcPrefs is the one shape both directions go through. Panel keys are kept whatever
 * they are (as long as they look like a key): other slices add panels, and a key this server
 * has never heard of must survive a save.
 */

export interface CcFiltersPref {
  states: string[]
  sla: Array<'ok' | 'warning' | 'breached'>
  owner: string | null
}

export interface CcSavedViewPref {
  id: string
  name: string
  region: string | null
  map_collection: string | null
  filters: CcFiltersPref
}

export interface CcPrefsStored {
  layout: CcLayout | null
  theme: 'app' | 'dark'
  saved_views: CcSavedViewPref[]
  /** Seconds between regions while TV mode cycles (10–600). */
  tv_cycle_seconds: number
}

export const PREFS_KEY = 'command_center'
export const MAX_SAVED_VIEWS = 20
export const DEFAULT_TV_CYCLE_S = 30

/** Panel keys — the same shape CcConfig.role_defaults keeps (config.ts). */
const KEY = /^[A-Za-z0-9_]{1,64}$/
const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/
const REGION = /^[A-Za-z0-9_-]{1,64}$/
const NAME = /^[A-Za-z0-9_]{1,64}$/
const SLA = new Set(['ok', 'warning', 'breached'])

const keyList = (v: unknown, max = 60): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((s): s is string => typeof s === 'string' && KEY.test(s)))].slice(0, max)
    : []

export function normalizeCcLayout(v: unknown): CcLayout | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return { order: keyList(o.order), hidden: keyList(o.hidden) }
}

function normalizeFilters(v: unknown): CcFiltersPref {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const states = Array.isArray(o.states)
    ? [...new Set(o.states.map(String).filter((s) => s.length > 0 && s.length <= 64))].slice(0, 30)
    : []
  const sla = Array.isArray(o.sla)
    ? ([...new Set(o.sla.map(String))].filter((s) => SLA.has(s)) as CcFiltersPref['sla'])
    : []
  const owner =
    typeof o.owner === 'string' && o.owner.length > 0 && o.owner.length <= 64 ? o.owner : null
  return { states, sla, owner }
}

function normalizeView(v: unknown, i: number): CcSavedViewPref | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 60) : ''
  if (!name) return null
  const id = typeof o.id === 'string' && VIEW_ID.test(o.id) ? o.id : `view-${i + 1}`
  return {
    id,
    name,
    region: typeof o.region === 'string' && REGION.test(o.region) ? o.region : null,
    map_collection:
      typeof o.map_collection === 'string' && NAME.test(o.map_collection) ? o.map_collection : null,
    filters: normalizeFilters(o.filters)
  }
}

export function normalizeCcPrefs(raw: unknown): CcPrefsStored {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const seen = new Set<string>()
  const views: CcSavedViewPref[] = []
  for (const [i, v] of (Array.isArray(o.saved_views) ? o.saved_views : []).entries()) {
    const n = normalizeView(v, i)
    if (!n || seen.has(n.id)) continue
    seen.add(n.id)
    views.push(n)
    if (views.length >= MAX_SAVED_VIEWS) break
  }
  const cycle = Number(o.tv_cycle_seconds)
  return {
    layout: normalizeCcLayout(o.layout),
    theme: o.theme === 'dark' ? 'dark' : 'app',
    saved_views: views,
    tv_cycle_seconds:
      Number.isFinite(cycle) && cycle >= 10 && cycle <= 600 ? Math.round(cycle) : DEFAULT_TV_CYCLE_S
  }
}

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

export async function readCcPrefs(userId: string): Promise<CcPrefsStored> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  return normalizeCcPrefs(parsePreferences(row?.preferences)[PREFS_KEY])
}

/** Merge a change into the person's Command Center preferences; returns what is now stored. */
export async function writeCcPrefs(
  userId: string,
  change: (current: CcPrefsStored) => CcPrefsStored
): Promise<CcPrefsStored> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  const all = parsePreferences(row?.preferences)
  const next = normalizeCcPrefs(change(normalizeCcPrefs(all[PREFS_KEY])))
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify({ ...all, [PREFS_KEY]: next }) })
  return next
}

/** A PUT body applied to the stored prefs: only the keys sent change; layout null = role's. */
export function applyPrefsChange(
  current: CcPrefsStored,
  body: Record<string, unknown>
): CcPrefsStored {
  return normalizeCcPrefs({
    ...current,
    ...('layout' in body ? { layout: body.layout === null ? null : body.layout } : {}),
    ...('theme' in body ? { theme: body.theme } : {}),
    ...('saved_views' in body ? { saved_views: body.saved_views } : {}),
    ...('tv_cycle_seconds' in body ? { tv_cycle_seconds: body.tv_cycle_seconds } : {})
  })
}

export const PREFS_BODY_KEYS = ['layout', 'theme', 'saved_views', 'tv_cycle_seconds'] as const

/** Why a PUT body is refused, or null. */
export function prefsBodyRefusal(body: Record<string, unknown>): string | null {
  if (!PREFS_BODY_KEYS.some((k) => k in body)) return `Send one of: ${PREFS_BODY_KEYS.join(', ')}`
  if ('layout' in body && body.layout !== null && !normalizeCcLayout(body.layout))
    return 'layout must be {order, hidden} or null'
  if ('theme' in body && body.theme !== 'app' && body.theme !== 'dark')
    return "theme must be 'app' or 'dark'"
  if ('saved_views' in body && !Array.isArray(body.saved_views)) return 'saved_views must be a list'
  return null
}

const roleKey = (role: unknown) => (role == null ? '' : String(role).toLowerCase())

export async function ccRoleDefaultFor(role: unknown): Promise<CcLayout | null> {
  const key = roleKey(role)
  if (!key) return null
  const cfg = await readCcConfig()
  return cfg.role_defaults[key] ?? null
}

export async function readCcRoleDefaults(): Promise<Record<string, CcLayout>> {
  return (await readCcConfig()).role_defaults
}

/** Set (layout) or clear (null) one role's starting layout; returns the whole map. */
export async function writeCcRoleDefault(
  roleId: string,
  layout: CcLayout | null
): Promise<Record<string, CcLayout>> {
  const key = roleKey(roleId)
  const next = await writeCcConfig((cfg) => {
    const map = { ...cfg.role_defaults }
    if (layout) map[key] = layout
    else delete map[key]
    return { ...cfg, role_defaults: map }
  })
  return next.role_defaults
}
