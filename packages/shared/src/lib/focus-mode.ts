import { useSyncExternalStore } from 'react'

/**
 * Focus mode for live updates (#2386) — a per-person switch that holds the
 * live feed back: list rows, counters and pills collect what arrived and
 * apply it in one go every few minutes, or at once when the person clicks the
 * "12 updates" pill. Critical notifications never pass through here (they
 * ride the notification channels, not the collection feed).
 *
 * Surfaces opt in by routing their events through `deliverLive(owner, events,
 * apply)`: with focus off `apply` runs straight away; with focus on the events
 * are held per owner and handed to `apply` together when the window ends.
 * `useLiveCollection(..., { focusable: true })` does this for hook users.
 */

const KEY = 'nvr:focus-mode'
const DEFAULT_MINUTES = 3

interface FocusPrefs {
  on: boolean
  minutes: number
}

interface Held {
  events: unknown[]
  apply: (events: any[]) => void
}

let prefs: FocusPrefs = readPrefs()
const held = new Map<object, Held>()
let heldCount = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
let snapshot = { on: prefs.on, minutes: prefs.minutes, held: 0 }

function readPrefs(): FocusPrefs {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<FocusPrefs>
      return {
        on: p.on === true,
        minutes: clampMinutes(p.minutes)
      }
    }
  } catch {
    /* private window / blocked storage — fall through to the default */
  }
  return { on: false, minutes: DEFAULT_MINUTES }
}

function clampMinutes(m: unknown): number {
  const n = Number(m)
  if (!Number.isFinite(n)) return DEFAULT_MINUTES
  return Math.min(30, Math.max(1, Math.round(n)))
}

function emit() {
  snapshot = { on: prefs.on, minutes: prefs.minutes, held: heldCount }
  for (const l of listeners) l()
}

function schedule() {
  if (timer || held.size === 0 || !prefs.on) return
  timer = setTimeout(() => {
    timer = null
    applyHeldLiveNow()
  }, prefs.minutes * 60_000)
}

/** Run everything held back, now (the pill, switching focus off, or the window ending). */
export function applyHeldLiveNow(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const batches = [...held.values()]
  held.clear()
  heldCount = 0
  emit()
  for (const h of batches) {
    try {
      h.apply(h.events)
    } catch {
      /* one surface failing never blocks the others */
    }
  }
}

export function setFocusMode(on: boolean, minutes?: number): void {
  const next = { on, minutes: minutes == null ? prefs.minutes : clampMinutes(minutes) }
  const turningOff = prefs.on && !next.on
  prefs = next
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* unsaved — still applies for this page */
  }
  if (turningOff) applyHeldLiveNow()
  else {
    emit()
    schedule()
  }
}

export function isFocusModeOn(): boolean {
  return prefs.on
}

/**
 * Deliver live events: immediately, or held until the focus window ends.
 * `owner` identifies the surface (a ref object) so repeated events merge into
 * one pending batch and an unmounted surface can drop its backlog.
 */
export function deliverLive<E>(owner: object, events: E[], apply: (events: E[]) => void): void {
  if (events.length === 0) return
  if (!prefs.on) {
    apply(events)
    return
  }
  const cur = held.get(owner)
  if (cur) {
    cur.events.push(...events)
    cur.apply = apply as Held['apply']
  } else held.set(owner, { events: [...events], apply: apply as Held['apply'] })
  heldCount += events.length
  emit()
  schedule()
}

/** A surface went away: forget what it was holding. */
export function releaseLiveOwner(owner: object): void {
  const cur = held.get(owner)
  if (!cur) return
  held.delete(owner)
  heldCount = Math.max(0, heldCount - cur.events.length)
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** `{on, minutes, held}` — re-renders when focus mode or the held count changes. */
export function useFocusMode(): { on: boolean; minutes: number; held: number } {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  )
}

/** Test seam: back to defaults, nothing held. */
export function resetFocusModeForTests(): void {
  if (timer) clearTimeout(timer)
  timer = null
  held.clear()
  heldCount = 0
  prefs = { on: false, minutes: DEFAULT_MINUTES }
  emit()
}
