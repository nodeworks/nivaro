import { useCallback, useState, useSyncExternalStore } from 'react'

// Per-viewer editor view choices (#2627 compact canvas, #2621 outline open,
// #3188 canvas zoom, #3200 pinned inspector settings): kept in this browser
// only. Storage can be missing or throw (private windows, blocked site data)
// — the editor then just starts with defaults.

const KEYS = {
  compact: 'nvr_layout_editor_compact',
  outline: 'nvr_layout_editor_outline'
} as const

export type ViewPref = keyof typeof KEYS

export function readViewPref(k: ViewPref): boolean {
  try {
    return localStorage.getItem(KEYS[k]) === '1'
  } catch {
    return false
  }
}

export function writeViewPref(k: ViewPref, on: boolean): void {
  try {
    if (on) localStorage.setItem(KEYS[k], '1')
    else localStorage.removeItem(KEYS[k])
  } catch {
    /* not kept: fine */
  }
}

/** A remembered on/off view choice. */
export function useViewPref(k: ViewPref): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readViewPref(k))
  const set = useCallback(
    (v: boolean) => {
      setOn(v)
      writeViewPref(k, v)
    },
    [k]
  )
  return [on, set]
}

/** The compact canvas's zoom: spacing, inputs and text shrink together. */
export const COMPACT_ZOOM = 0.8

// ─── Canvas zoom (#3188) ────────────────────────────────────────────────────

const ZOOM_KEY = 'nvr_layout_editor_zoom'
export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 1.5
export const ZOOM_STEP = 0.05

/** A zoom on the slider's grid, inside its range (anything unreadable is 100%). */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1
  const stepped = Math.round(z / ZOOM_STEP) * ZOOM_STEP
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped)) * 100) / 100
}

export function readZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY)
    return raw == null ? 1 : clampZoom(Number(raw))
  } catch {
    return 1
  }
}

/** The canvas zoom this viewer chose (100% unless changed), remembered here. */
export function useCanvasZoom(): [number, (z: number) => void] {
  const [zoom, setZoomState] = useState(readZoom)
  const set = useCallback((z: number) => {
    const v = clampZoom(z)
    setZoomState(v)
    try {
      if (v === 1) localStorage.removeItem(ZOOM_KEY)
      else localStorage.setItem(ZOOM_KEY, String(v))
    } catch {
      /* not kept: fine */
    }
  }, [])
  return [zoom, set]
}

/** What the canvas is drawn at: the zoom, times the compact canvas's own. */
export function effectiveZoom(zoom: number, compact: boolean): number {
  return Math.round(zoom * (compact ? COMPACT_ZOOM : 1) * 1000) / 1000
}

/**
 * The zoom that fits `natural` px of canvas into a pane `pane` px wide (with
 * compact on, its own shrink counts). Never above 100%: Fit shows all of it,
 * it does not blow a phone frame up. Unknown width (the full-width desktop
 * canvas, which already fits) = 100%.
 */
export function fitZoom(pane: number, natural: number | null, compact: boolean): number {
  if (!natural || natural <= 0 || !pane || pane <= 0) return 1
  const base = compact ? COMPACT_ZOOM : 1
  // Round down to the slider's step so the fitted canvas never needs a scrollbar.
  const down = Math.floor(((pane / natural / base) * 1000) / (ZOOM_STEP * 1000)) * ZOOM_STEP
  return clampZoom(Math.min(1, down))
}

// ─── Pinned inspector settings (#3200) ──────────────────────────────────────

const PINS_KEY = 'nvr_layout_editor_pinned_settings'
/** More than anyone pins by hand; keeps a damaged list from growing without end. */
export const PINS_MAX = 60

let pinsCache: string[] | null = null
const pinListeners = new Set<() => void>()

function readPins(): string[] {
  if (pinsCache) return pinsCache
  let out: string[] = []
  try {
    const raw = localStorage.getItem(PINS_KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : []
    if (Array.isArray(v))
      out = [...new Set(v.filter((k): k is string => typeof k === 'string' && !!k))].slice(
        0,
        PINS_MAX
      )
  } catch {
    out = []
  }
  pinsCache = out
  return out
}

function writePins(next: string[]) {
  pinsCache = next.slice(0, PINS_MAX)
  try {
    if (pinsCache.length) localStorage.setItem(PINS_KEY, JSON.stringify(pinsCache))
    else localStorage.removeItem(PINS_KEY)
  } catch {
    /* kept for this page only */
  }
  for (const l of pinListeners) l()
}

/** Pin or unpin one setting (its parity key) for this viewer. */
export function togglePinnedSetting(k: string): void {
  const cur = readPins()
  writePins(cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k])
}

/** Forget the cached list (tests; storage changed underneath). */
export function resetPinnedSettingsCache(): void {
  pinsCache = null
  for (const l of pinListeners) l()
}

function subscribePins(l: () => void) {
  pinListeners.add(l)
  // Pinning in another tab shows here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PINS_KEY) return
    pinsCache = null
    l()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    pinListeners.delete(l)
    window.removeEventListener('storage', onStorage)
  }
}

const NO_PINS: string[] = []

/** The settings this viewer pinned, in the order they were pinned. */
export function usePinnedSettings(): string[] {
  return useSyncExternalStore(subscribePins, readPins, () => NO_PINS)
}
