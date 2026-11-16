import { useSyncExternalStore } from 'react'

/** Below Tailwind's `md` breakpoint: phones (and a phone-narrow window). */
export const BELOW_MD_QUERY = '(max-width: 767px)'

function mediaList(): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return null
    return window.matchMedia(BELOW_MD_QUERY)
  } catch {
    return null
  }
}

function subscribe(onChange: () => void): () => void {
  const mql = mediaList()
  if (!mql) return () => {}
  mql.addEventListener?.('change', onChange)
  return () => mql.removeEventListener?.('change', onChange)
}

const snapshot = () => mediaList()?.matches ?? false

/** True while the window is narrower than `md` (768 px); follows resizes and rotation. */
export function useBelowMd(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
