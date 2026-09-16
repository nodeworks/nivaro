/**
 * Approved accent palette (#83) — client twin of api/src/services/theme-accents.ts.
 * The instance declares accents in `nivaro_settings.theme_accents`; a user's
 * pick lives in `preferences.theme_accent`. `resolveAccentColor` is what a
 * host applies to the `--nvr-cyan*` tokens before its own brand fallback.
 */
export interface ThemeAccent {
  key: string
  label: string
  /** #rrggbb; null = the instance brand colour. */
  color: string | null
}

export const BRAND_ACCENT: ThemeAccent = { key: 'brand', label: 'Brand', color: null }

export const DEFAULT_THEME_ACCENTS: ThemeAccent[] = [
  { key: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { key: 'emerald', label: 'Emerald', color: '#059669' },
  { key: 'rose', label: 'Rose', color: '#e11d48' }
]

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
const HEX = /^#[0-9a-fA-F]{6}$/

/** Lenient parse of the settings column (string or array); defaults when unusable. */
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
    if (out.length >= 6) break
  }
  return out
}

/** The colour a user's pick resolves to, or null for "use the brand colour". */
export function resolveAccentColor(
  pick: unknown,
  accents: ThemeAccent[] = DEFAULT_THEME_ACCENTS
): string | null {
  if (typeof pick !== 'string' || !pick || pick === 'brand') return null
  return accents.find((a) => a.key === pick)?.color ?? null
}
