import { db } from '../db/index.js'

/**
 * Approved accent palette (#83). The instance owner declares up to a few
 * accents; a user picks ONE of them (or 'brand' = the instance colour) and
 * every host applies it to the `--nvr-cyan*` tokens. Validation lives here so
 * the preference route and the settings route agree on the shape.
 */
export interface ThemeAccent {
  key: string
  label: string
  /** #rrggbb; null = the instance brand colour (project_color / workspace). */
  color: string | null
}

export const BRAND_ACCENT: ThemeAccent = { key: 'brand', label: 'Brand', color: null }

/** Sensible defaults when the instance has not declared its own. */
export const DEFAULT_THEME_ACCENTS: ThemeAccent[] = [
  { key: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { key: 'emerald', label: 'Emerald', color: '#059669' },
  { key: 'rose', label: 'Rose', color: '#e11d48' }
]

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
const HEX = /^#[0-9a-fA-F]{6}$/
export const MAX_THEME_ACCENTS = 6

/** Lenient parse of the stored column; anything unusable collapses to the defaults. */
export function parseThemeAccents(raw: unknown): ThemeAccent[] {
  if (raw == null || raw === '') return DEFAULT_THEME_ACCENTS
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return DEFAULT_THEME_ACCENTS
    }
  }
  if (!Array.isArray(v)) return DEFAULT_THEME_ACCENTS
  const out: ThemeAccent[] = []
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const key = String((e as { key?: unknown }).key ?? '').trim()
    const color = String((e as { color?: unknown }).color ?? '').trim()
    if (!KEY.test(key) || key === 'brand' || !HEX.test(color)) continue
    if (out.some((o) => o.key === key)) continue
    out.push({
      key,
      label: String((e as { label?: unknown }).label ?? key).slice(0, 40) || key,
      color: color.toLowerCase()
    })
    if (out.length >= MAX_THEME_ACCENTS) break
  }
  return out
}

/** Strict validation for the settings PATCH — returns the error text or null. */
export function validateThemeAccents(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return 'theme_accents must be a JSON array'
    }
  }
  if (!Array.isArray(v)) return 'theme_accents must be a JSON array'
  if (v.length > MAX_THEME_ACCENTS)
    return `theme_accents holds at most ${MAX_THEME_ACCENTS} accents`
  const seen = new Set<string>()
  for (const e of v) {
    const key = String((e as { key?: unknown })?.key ?? '')
    const color = String((e as { color?: unknown })?.color ?? '')
    if (!KEY.test(key)) return `accent key "${key}" must be a short lowercase slug`
    if (key === 'brand') return 'the key "brand" is reserved for the instance colour'
    if (seen.has(key)) return `accent key "${key}" is listed twice`
    seen.add(key)
    if (!HEX.test(color)) return `accent "${key}" needs a #rrggbb colour`
  }
  return null
}

/** The accents users may currently pick on this instance (brand first). */
export async function listThemeAccents(): Promise<ThemeAccent[]> {
  const row = (await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('theme_accents')
    .catch(() => null)) as { theme_accents?: unknown } | null
  return [BRAND_ACCENT, ...parseThemeAccents(row?.theme_accents)]
}
