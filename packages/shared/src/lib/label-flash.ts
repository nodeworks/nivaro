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
