import { useCallback, useState } from 'react'

// Per-viewer editor view choices (#2627 compact canvas, #2621 outline open):
// kept in this browser only. Storage can be missing or throw (private
// windows, blocked site data) — the editor then just starts with defaults.

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
