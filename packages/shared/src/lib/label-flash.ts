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

/** The renamed link's FIELD BOX flashes (border + ring, ~1.2 s, light and dark) — a wash on
 *  the text alone read as a text selection on a dark field. */
export function flashFieldBox(el: HTMLElement | null): void {
  if (!el || typeof el.animate !== 'function') return
  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const on = {
    borderColor: dark ? 'rgb(34, 211, 238)' : 'rgb(8, 145, 178)',
    boxShadow: `0 0 0 3px rgba(34, 211, 238, ${dark ? 0.35 : 0.28})`
  }
  const off = {
    borderColor: getComputedStyle(el).borderColor,
    boxShadow: '0 0 0 3px rgba(34, 211, 238, 0)'
  }
  el.animate([on, { ...on, offset: 0.4 }, off], {
    duration: 1200,
    easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
  })
}
