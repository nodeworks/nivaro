import { useEffect, useRef, useState } from 'react'
import { liveMotionAllowed } from './live-preference'

/**
 * A linked record's name changed under the viewer (rt9 #8: someone renamed the project this
 * field points at): the shown name flashes once, the same soft cyan wash other live values use
 * (`nvr-value-pulse-bg`). Only when the link itself stayed the same — picking another record is
 * the viewer's own doing — and only in Normal live mode without reduced motion.
 *
 * Returns a counter: 0 = never flashed; use it as the element's `key` so each change replays.
 */
export function useLabelFlash(id: unknown, label: string | null | undefined): number {
  const prev = useRef<{ id: unknown; label: string | null | undefined }>({ id, label })
  const [flash, setFlash] = useState(0)
  useEffect(() => {
    const p = prev.current
    prev.current = { id, label }
    if (
      id != null &&
      String(p.id) === String(id) &&
      p.label != null &&
      label != null &&
      p.label !== label &&
      liveMotionAllowed()
    )
      setFlash((n) => n + 1)
  }, [id, label])
  return flash
}

/** Ref callback for the flashed name: a cyan wash plus a 1px ring, stronger on a dark field
 *  (the shared `nvr-value-pulse-bg` wash all but vanished there). Runs once per mount — the
 *  element is keyed on the flash counter. */
export function flashLabelRef(el: HTMLElement | null): void {
  if (!el || typeof el.animate !== 'function') return
  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const a = dark ? 0.4 : 0.2
  const r = dark ? 0.9 : 0.45
  el.animate(
    [
      {
        backgroundColor: `rgba(34, 211, 238, ${a})`,
        boxShadow: `0 0 0 1px rgba(34, 211, 238, ${r})`
      },
      {
        backgroundColor: `rgba(34, 211, 238, ${a})`,
        boxShadow: `0 0 0 1px rgba(34, 211, 238, ${r})`,
        offset: 0.35
      },
      { backgroundColor: 'rgba(34, 211, 238, 0)', boxShadow: '0 0 0 1px rgba(34, 211, 238, 0)' }
    ],
    { duration: 1600, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
  )
}
