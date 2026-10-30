import { type CSSProperties, useEffect, useState } from 'react'

/**
 * Command Center colour tokens. The board follows the app's light/dark theme by default and
 * can be pinned to dark for wall screens (CcPrefs.theme). Every panel styles through these
 * CSS variables (set once on the board root), never through bare slate/white classes, so one
 * switch flips the whole board. Status colours (SLA red/amber, people green) stay the same in
 * both themes; their text variants are picked per theme for contrast.
 */
export type CcMode = 'light' | 'dark'

const TOKENS: Record<CcMode, Record<string, string>> = {
  light: {
    '--cc-bg': '#f6f8fa',
    '--cc-panel': '#ffffff',
    '--cc-raised': '#f1f5f9',
    '--cc-border': '#e2e8f0',
    '--cc-text': '#0f172a',
    '--cc-strong': '#020617',
    '--cc-muted': '#475569',
    '--cc-faint': '#64748b',
    '--cc-chip': 'rgba(15, 23, 42, 0.05)',
    '--cc-chip-hover': 'rgba(15, 23, 42, 0.09)',
    '--cc-people': '#059669',
    '--cc-people-text': '#047857',
    '--cc-warn-text': '#b45309',
    '--cc-bad-text': '#b91c1c',
    '--cc-good-text': '#047857',
    '--cc-map-tint': '0'
  },
  dark: {
    '--cc-bg': '#0b1220',
    '--cc-panel': '#101828',
    '--cc-raised': '#162033',
    '--cc-border': 'rgba(255, 255, 255, 0.1)',
    '--cc-text': '#e2e8f0',
    '--cc-strong': '#ffffff',
    '--cc-muted': '#94a3b8',
    '--cc-faint': '#8291a8',
    '--cc-chip': 'rgba(255, 255, 255, 0.05)',
    '--cc-chip-hover': 'rgba(255, 255, 255, 0.1)',
    '--cc-people': '#34d399',
    '--cc-people-text': '#6ee7b7',
    '--cc-warn-text': '#fbbf24',
    '--cc-bad-text': '#f87171',
    '--cc-good-text': '#34d399',
    '--cc-map-tint': '1'
  }
}

export function ccVars(mode: CcMode): CSSProperties {
  return TOKENS[mode] as CSSProperties
}

/** True while the host app is in dark mode (`.dark` on <html>), live. */
const readAppDark = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

export function useAppIsDark(): boolean {
  const [dark, setDark] = useState(readAppDark)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => setDark(readAppDark()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

// Shared class strings — every panel uses these so the board reads as one surface.
export const PANEL = 'rounded-lg border border-[var(--cc-border)] bg-[var(--cc-panel)]'
export const PANEL_HEAD =
  'flex items-center justify-between gap-2 border-b border-[var(--cc-border)] px-3 py-2'
export const TITLE = 'text-[12.5px] font-semibold text-[var(--cc-strong)]'
export const MUTED = 'text-[var(--cc-muted)]'
export const FAINT = 'text-[var(--cc-faint)]'
export const CHIP =
  'rounded-full bg-[var(--cc-chip)] px-2 py-0.5 text-[11.5px] text-[var(--cc-text)] hover:bg-[var(--cc-chip-hover)]'
export const BUTTON =
  'rounded-md border border-[var(--cc-border)] px-2.5 py-1 text-[11.5px] text-[var(--cc-text)] hover:bg-[var(--cc-chip)] disabled:opacity-50'
export const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-0'

export function rel(ts: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}
