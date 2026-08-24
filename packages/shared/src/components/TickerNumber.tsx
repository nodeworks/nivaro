import { useEffect, useRef, useState } from 'react'

/**
 * Number ticker (#320): rolls to a new value with an eased count instead of
 * snapping. Cosmetic — the true value is always the final frame. Respects
 * prefers-reduced-motion (snaps), and the FIRST render never animates (a page
 * load is not a change).
 */
export function TickerNumber({
  value,
  format,
  durationMs = 450
}: {
  value: number
  format?: (n: number) => string
  durationMs?: number
}) {
  const [display, setDisplay] = useState(value)
  const prevRef = useRef<number | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = value
    if (prev === null || prev === value) {
      setDisplay(value)
      return
    }
    if (
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setDisplay(value)
      return
    }
    const start = performance.now()
    const from = prev
    const delta = value - from
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const eased = 1 - (1 - t) ** 3
      setDisplay(t >= 1 ? value : Math.round(from + delta * eased))
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value, durationMs])

  return <>{format ? format(display) : display.toLocaleString()}</>
}
