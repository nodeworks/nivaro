import { useCallback, useEffect, useRef, useState } from 'react'

/** Re-render every `ms` while `on` (a live "Updated 6s ago"); returns the current time. */
export function useNow(ms = 1000, on = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms, on])
  return now
}

/** The window's width, live (the shell turns it into a BoardSize). */
const readWidth = () => (typeof window === 'undefined' ? 1440 : window.innerWidth)

export function useWindowWidth(): number {
  const [w, setW] = useState(readWidth)
  useEffect(() => {
    const on = () => setW(readWidth())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

export function usePrefersReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)'
  const [v, setV] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches
  )
  useEffect(() => {
    const mq = window.matchMedia?.(q)
    if (!mq) return
    const on = () => setV(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return v
}

/**
 * Full screen for the board (CC-23): the board always becomes a full-window layer (so the app's
 * sidebar and header are covered, and popovers / the record panel still show above it) and, where
 * the browser allows, the page also enters real full screen. Leaving real full screen with the
 * browser's own Esc leaves the board's full-window layer too.
 */
export function useFullscreen() {
  const [on, setOn] = useState(false)
  const native = useRef(false)

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && native.current) {
        native.current = false
        setOn(false)
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const enter = useCallback(() => {
    setOn(true)
    const el = document.documentElement
    if (document.fullscreenEnabled && el.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen()
        .then(() => {
          native.current = true
        })
        .catch(() => {
          native.current = false
        })
    }
  }, [])

  const exit = useCallback(() => {
    setOn(false)
    if (document.fullscreenElement && document.exitFullscreen) {
      native.current = false
      void document.exitFullscreen().catch(() => undefined)
    }
  }, [])

  const toggle = useCallback(() => (on ? exit() : enter()), [on, enter, exit])
  return { on, enter, exit, toggle }
}

/** How long after the last touch, click, key or scroll TV mode waits before cycling again. */
export const TV_IDLE_MS = 60_000

/** The region after `current` in the TV cycle: everywhere first, then each region in order. */
export function nextRegion(regionIds: string[], current: string | null): string | null {
  const cycle: Array<string | null> = [null, ...regionIds]
  const i = cycle.indexOf(current)
  return cycle[(i + 1) % cycle.length] ?? null
}

/**
 * TV mode moves through the regions every `intervalMs` while nobody is using the board (no
 * pointer, key, wheel or touch for TV_IDLE_MS). Off with fewer than one region.
 */
export function useRegionCycle(input: {
  enabled: boolean
  regionIds: string[]
  current: string | null
  setRegion: (id: string | null) => void
  intervalMs: number
}) {
  const { enabled, regionIds, current, setRegion, intervalMs } = input
  const lastInput = useRef(0)
  const latest = useRef({ current, regionIds, setRegion })
  latest.current = { current, regionIds, setRegion }

  useEffect(() => {
    if (!enabled) return
    const mark = () => {
      lastInput.current = Date.now()
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    for (const e of events) window.addEventListener(e, mark, { passive: true })
    return () => {
      for (const e of events) window.removeEventListener(e, mark)
    }
  }, [enabled])

  const count = regionIds.length
  useEffect(() => {
    if (!enabled || count === 0) return
    const t = setInterval(
      () => {
        if (Date.now() - lastInput.current < TV_IDLE_MS) return
        const l = latest.current
        l.setRegion(nextRegion(l.regionIds, l.current))
      },
      Math.max(5_000, intervalMs)
    )
    return () => clearInterval(t)
  }, [enabled, count, intervalMs])
}

/**
 * Focus management for the record peek panel (CC-27): when a record opens, focus moves into the
 * panel (`[data-cc-peek]`, slice 1's root) and Tab stays inside it; when it closes, focus goes
 * back to whatever opened it.
 */
export function usePeekFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    opener.current = (document.activeElement as HTMLElement | null) ?? null
    let tries = 0
    let raf = 0
    const focusIn = () => {
      const host = document.querySelector<HTMLElement>('[data-cc-peek]')
      if (!host) {
        if (tries++ < 20) raf = requestAnimationFrame(focusIn)
        return
      }
      if (host.contains(document.activeElement)) return
      const first = focusables(host)[0]
      ;(first ?? host).focus({ preventScroll: true })
    }
    raf = requestAnimationFrame(focusIn)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const host = document.querySelector<HTMLElement>('[data-cc-peek]')
      if (!host?.contains(document.activeElement)) return
      const list = focusables(host)
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      const back = opener.current
      opener.current = null
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [open])
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null
  )
}
