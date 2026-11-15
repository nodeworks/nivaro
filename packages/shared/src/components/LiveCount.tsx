import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A count that follows live data: when the number changes the old one fades out while the new
 * one fades in, in the same spot (both share one grid cell, so nothing shifts or bounces).
 * Reduced motion, a first render and a value that did not change just show the number.
 */

const FADE_MS = 220

export function reducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    )
  } catch {
    return false
  }
}

/** What to show for a value: numbers as-is, null / undefined as nothing. */
export function countText(value: number | string | null | undefined): string {
  return value == null ? '' : String(value)
}

export interface LiveCountProps {
  value: number | string | null | undefined
  /** Render the text (e.g. `99+`, a unit); default is the plain number. */
  format?: (value: number | string) => ReactNode
  className?: string
}

export function LiveCount({ value, format, className }: LiveCountProps) {
  const text = countText(value)
  const shownRef = useRef(text)
  const [outgoing, setOutgoing] = useState<{ text: string; id: number } | null>(null)
  const incoming = useRef<HTMLSpanElement | null>(null)
  const outEl = useRef<HTMLSpanElement | null>(null)
  const idRef = useRef(0)

  useLayoutEffect(() => {
    const before = shownRef.current
    shownRef.current = text
    if (before === text || before === '' || text === '' || reducedMotion()) {
      setOutgoing(null)
      return
    }
    idRef.current += 1
    setOutgoing({ text: before, id: idRef.current })
    const el = incoming.current
    if (el && typeof el.animate === 'function')
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out' })
  }, [text])

  useEffect(() => {
    if (!outgoing) return
    const el = outEl.current
    if (el && typeof el.animate === 'function')
      el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: 'ease-out',
        fill: 'forwards'
      })
    const t = setTimeout(
      () => setOutgoing((o) => (o && o.id === outgoing.id ? null : o)),
      FADE_MS + 30
    )
    return () => clearTimeout(t)
  }, [outgoing])

  const render = (t: string): ReactNode =>
    format && t !== '' ? format(/^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t) : t

  return (
    <span className={className} style={{ display: 'inline-grid' }} data-live-count={text}>
      {outgoing && (
        <span
          ref={outEl}
          aria-hidden='true'
          style={{ gridArea: '1 / 1', pointerEvents: 'none', opacity: 0 }}
        >
          {render(outgoing.text)}
        </span>
      )}
      <span ref={incoming} style={{ gridArea: '1 / 1' }}>
        {render(text)}
      </span>
    </span>
  )
}
