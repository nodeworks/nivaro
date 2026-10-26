import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { parseThemeAccents, resolveAccentColor } from './theme-accents'
import { setDisplayTimezone, setNumberFormat, setTimeDisplay } from './utils'

/**
 * Profile → Display preferences (#31/#229/#230/#232/#411/#83), applied by a host.
 *
 * Every app that renders the Display card must also APPLY what it saves, or the
 * card does nothing there (efp-new, until 2026-10-26). Admin's AppLayout and
 * efp-new's shell both go through `applyDisplayPrefs` — one reading of the
 * preference object, two hosts. Hosts without admin's own accent chain
 * (workspace colour, project colour, theme studio) mount `useDisplayPreferences`.
 */

export interface DisplayPrefs {
  timezone?: string | null
  time_display?: string | null
  number_format?: { locale?: string; compact?: boolean } | null
  font_size?: string | null
  theme_accent?: string | null
}

/** Root font size for the Text size pick; '' = the stylesheet's own. */
export function rootFontSize(pref: unknown): string {
  return pref === 'small' ? '15px' : pref === 'large' ? '17.5px' : ''
}

/**
 * Point the shared formatters at the person's preferences and scale the root.
 * `defaultTimezone` = the instance default (#178) for people without a pick.
 */
export function applyDisplayPrefs(
  prefs: DisplayPrefs | Record<string, unknown> | null | undefined,
  defaultTimezone: string | null = null,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement
): void {
  const p = (prefs ?? {}) as DisplayPrefs
  setDisplayTimezone(typeof p.timezone === 'string' && p.timezone ? p.timezone : defaultTimezone)
  setTimeDisplay(p.time_display ?? null)
  setNumberFormat(p.number_format ?? null)
  if (root) root.style.fontSize = rootFontSize(p.font_size)
}

/** `#00ceff` / `#0cf` → `"0 206 255"` (the channel form Tailwind's `/N` opacity
 *  reads). Null for anything else, so a non-hex setting leaves the default
 *  channels in place rather than breaking every tinted surface. */
export function hexToRgbChannels(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h =
    m[1].length === 3
      ? m[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1]
  const n = Number.parseInt(h, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

function luminance(hex: string): number {
  const ch = hexToRgbChannels(hex)
  if (!ch) return 0
  const [r, g, b] = ch.split(' ').map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function mix(hex: string, toward: string, share: number): string {
  const a = (hexToRgbChannels(hex) ?? '0 0 0').split(' ').map(Number)
  const b = (hexToRgbChannels(toward) ?? '0 0 0').split(' ').map(Number)
  return `#${a
    .map((v, i) => Math.round(v + (b[i] - v) * share))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * The accent, lightened just enough to read as text on a dark surface
 * (4.5:1). A deep accent (indigo) is fine on white but sinks into charcoal.
 */
export function liftForDarkSurface(hex: string, surface: string, min = 4.5): string {
  let out = hex
  for (let i = 1; i <= 20 && contrastRatio(out, surface) < min; i++)
    out = mix(hex, '#ffffff', i * 0.05)
  return out
}

/** Which ink reads on a solid accent fill: light (white) or dark (navy). */
export function accentInk(hex: string, darkInk = '#080f1c'): 'light' | 'dark' {
  return contrastRatio(hex, '#ffffff') >= contrastRatio(hex, darkInk) ? 'light' : 'dark'
}

export interface AccentTargets {
  /** Custom properties that take the colour as #rrggbb. */
  hex?: string[]
  /** Custom properties that take it as channels ('r g b'). */
  rgb?: string[]
}

/** Set (or, with null, remove) the accent on `root`; `data-accent-ink` says which ink reads on it. */
export function applyAccentVars(
  color: string | null,
  targets: AccentTargets,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement
): void {
  if (!root) return
  const rgb = color ? hexToRgbChannels(color) : null
  for (const v of targets.hex ?? []) {
    if (color && rgb) root.style.setProperty(v, color)
    else root.style.removeProperty(v)
  }
  for (const v of targets.rgb ?? []) {
    if (rgb) root.style.setProperty(v, rgb)
    else root.style.removeProperty(v)
  }
  if (color && rgb) root.dataset.accentInk = accentInk(color)
  else delete root.dataset.accentInk
}

/**
 * Apply a person's display preferences in a host shell (efp-new). Reads the
 * instance default timezone and accent palette from GET /settings (public keys).
 * Only an explicit accent pick is applied — "Brand" leaves the host's own theme
 * alone. On a dark theme the pick is lifted to stay legible (`darkSurface`).
 */
export function useDisplayPreferences(
  prefs: Record<string, unknown> | null | undefined,
  opts: { accent?: AccentTargets; dark?: boolean; darkSurface?: string } = {}
): void {
  const client = useOptionalNivaroClient()
  const { data: settings } = useQuery({
    queryKey: ['nvr-display-settings'],
    queryFn: () =>
      client!
        .request<{ data: { default_timezone?: string | null; theme_accents?: unknown } }>(
          get('/settings')
        )
        .then((r) => r.data ?? {}),
    enabled: !!client && !!prefs,
    staleTime: 5 * 60_000,
    retry: false
  })
  const p = (prefs ?? null) as DisplayPrefs | null
  const fmtKey = JSON.stringify([
    p?.timezone ?? null,
    p?.time_display ?? null,
    p?.number_format ?? null,
    p?.font_size ?? null,
    settings?.default_timezone ?? null
  ])
  // biome-ignore lint/correctness/useExhaustiveDependencies: fmtKey is the dependency
  useEffect(() => {
    if (!p) return
    applyDisplayPrefs(p, settings?.default_timezone ?? null)
  }, [fmtKey])
  useEffect(() => () => applyDisplayPrefs(null), [])

  const picked = p
    ? resolveAccentColor(p.theme_accent, parseThemeAccents(settings?.theme_accents))
    : null
  const color =
    picked && opts.dark && opts.darkSurface ? liftForDarkSurface(picked, opts.darkSurface) : picked
  const targetsKey = JSON.stringify(opts.accent ?? {})
  // biome-ignore lint/correctness/useExhaustiveDependencies: targetsKey stands for opts.accent
  useEffect(() => {
    if (!opts.accent) return
    const targets = opts.accent
    applyAccentVars(color, targets)
    return () => applyAccentVars(null, targets)
  }, [color, targetsKey])
}
