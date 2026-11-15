import { useCallback, useSyncExternalStore } from 'react'
import { formatRelative } from './utils'

/**
 * One shared ticker per tab (rt4 #23). "Last changed 2m ago" moves forward on its own: every
 * relative time on screen subscribes to this ONE timer instead of owning an interval, and the
 * timer only runs while something is subscribed and the tab is visible.
 *
 * A subscriber (`useRelativeText`) re-renders only when its OWN text changes ("2m ago" →
 * "3m ago"), never on a tick that leaves it as it was — so a list of 100 rows costs one timer
 * and a handful of tiny re-renders a minute, and nothing the person is looking at moves.
 * Times older than a week read as a date, which never changes: those do not subscribe.
 */

const TICK_MS = 30_000

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let visibilityBound = false

function fire(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      /* one subscriber's failure never stops the others */
    }
  }
}

function start(): void {
  if (timer || listeners.size === 0) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  timer = setInterval(fire, TICK_MS)
}

function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function onVisibility(): void {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'visible') {
    // Back in view: catch up at once, then keep the cadence.
    fire()
    start()
  } else {
    stop()
  }
}

/** Subscribe to the tab's ticker; returns the unsubscribe. Exported for tests and hosts. */
export function subscribeRelativeTick(cb: () => void): () => void {
  listeners.add(cb)
  if (!visibilityBound && typeof document !== 'undefined') {
    visibilityBound = true
    document.addEventListener('visibilitychange', onVisibility)
  }
  start()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) stop()
  }
}

/** Subscribers right now (tests). */
export function relativeTickSubscribers(): number {
  return listeners.size
}

/** Force one tick (tests; a host after a clock correction). */
export function tickRelativeNow(): void {
  fire()
}

/** A time old enough that its text is a calendar date and never changes again. */
function isSettled(value: string | Date | number | null | undefined, now: number): boolean {
  if (value === null || value === undefined || value === '') return true
  const t = new Date(value).getTime()
  return Number.isNaN(t) || now - t > 7 * 86_400_000
}

/** `formatRelative(value)` that moves forward by itself. */
export function useRelativeText(
  value: string | Date | number | null | undefined,
  format: (v: string | Date | number) => string = (v) => formatRelative(v as string | Date)
): string {
  const text = () => (value === null || value === undefined || value === '' ? '' : format(value))
  const settled = isSettled(value, Date.now())
  const subscribe = useCallback(
    (cb: () => void) => (settled ? () => {} : subscribeRelativeTick(cb)),
    [settled]
  )
  return useSyncExternalStore(subscribe, text, text)
}
