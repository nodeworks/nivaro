import { type ReactNode, useEffect, useRef } from 'react'
import { liveMotionAllowed } from '../lib/live-preference'

/**
 * A number (or short text) that may change while someone watches — a read count, a delivered
 * count. When `value` changes after the first paint it gets one short, soft tint that fades
 * out; nothing moves, nothing is announced, and with reduced motion (or live updates set to
 * Calm / Off) it just changes. Never use it for a value the person is editing.
 */
export function LiveFigure({
  value,
  children,
  className
}: {
  /** What the flash watches: a change in this plays the fade. */
  value: string | number | null | undefined
  /** What to show (default: the value itself). */
  children?: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef<string | number | null | undefined>(value)
  useEffect(() => {
    if (Object.is(prev.current, value)) return
    prev.current = value
    const el = ref.current
    if (!el || typeof el.animate !== 'function' || !liveMotionAllowed()) return
    el.animate(
      [
        {
          boxShadow: '0 0 0 3px rgba(0, 206, 255, 0.28)',
          backgroundColor: 'rgba(0, 206, 255, 0.22)'
        },
        { boxShadow: '0 0 0 3px rgba(0, 206, 255, 0)', backgroundColor: 'rgba(0, 206, 255, 0)' }
      ],
      { duration: 1800, easing: 'ease-out' }
    )
  }, [value])
  return (
    <span ref={ref} className={className} style={{ borderRadius: 3 }} data-live-figure>
      {children ?? value}
    </span>
  )
}
