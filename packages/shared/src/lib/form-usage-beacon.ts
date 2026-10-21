/**
 * Form usage events (#2597/#2598) — one per form session, sent when the form
 * closes, batched, to POST /api/layout-usage/beacon. Fire and forget: usage
 * telemetry must never affect the form it measures.
 *
 * Transport as in rum.ts: sendBeacon survives pagehide but cannot carry an
 * Authorization header, so a bearer-token host takes a keepalive fetch.
 */

export interface FormUsageEvent {
  layout_id: number
  collection: string
  /** Saved record id; null for a new record. */
  item: string | null
  /** The session's first event (counts the open, the person, the record). */
  open: boolean
  saved: boolean
  abandoned_step: string | null
  steps: Record<string, number>
}

export interface BeaconTransport {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
}

const queue: FormUsageEvent[] = []
let transport: BeaconTransport | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let listening = false

const MAX_BATCH = 20
const FLUSH_MS = 15_000

export function flushFormUsage(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!transport || queue.length === 0) return
  const { apiBase, authHeaders, credentials } = transport
  while (queue.length) {
    const body = JSON.stringify({ events: queue.splice(0, MAX_BATCH) })
    try {
      const url = `${apiBase}/layout-usage/beacon`
      const bearer = Object.keys(authHeaders).length > 0
      const ok =
        !bearer &&
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
      if (!ok) {
        void fetch(url, {
          method: 'POST',
          credentials,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body,
          keepalive: true
        }).catch(() => {})
      }
    } catch {
      // never let telemetry throw
    }
  }
}

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('pagehide', flushFormUsage)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushFormUsage()
  })
}

export function queueFormUsage(ev: FormUsageEvent, t: BeaconTransport): void {
  transport = t
  queue.push(ev)
  listen()
  if (queue.length >= MAX_BATCH) flushFormUsage()
  else if (!timer) timer = setTimeout(flushFormUsage, FLUSH_MS)
}

/** Tests only. */
export function _formUsageQueue(): FormUsageEvent[] {
  return queue
}

/**
 * Time per step for one form session. `now` is injectable for tests. Time
 * only runs while the page is visible.
 */
export class StepClock {
  private steps: Record<string, number> = {}
  private current: string
  private since: number | null

  constructor(step: string, now: number, visible = true) {
    this.current = step
    this.since = visible ? now : null
  }

  private settle(now: number) {
    if (this.since == null) return
    const ms = Math.max(0, now - this.since)
    if (ms > 0) this.steps[this.current] = (this.steps[this.current] ?? 0) + ms
    this.since = now
  }

  step(key: string, now: number) {
    if (key === this.current) return
    this.settle(now)
    this.current = key
  }

  pause(now: number) {
    this.settle(now)
    this.since = null
  }

  resume(now: number) {
    if (this.since == null) this.since = now
  }

  get currentStep(): string {
    return this.current
  }

  /** The time so far, and start counting afresh (the clock keeps running). */
  take(now: number): { steps: Record<string, number>; total: number } {
    this.settle(now)
    const steps = this.steps
    this.steps = {}
    return { steps, total: Object.values(steps).reduce((a, b) => a + b, 0) }
  }
}

/** A session shorter than this that saved nothing is a remount, not a use. */
export const MIN_SESSION_MS = 400
/** A new record left within this long was not really started: no abandon. */
export const MIN_ABANDON_MS = 3000

/**
 * The event a session sends, or null when there is nothing worth sending.
 * `total` is the time in this chunk, `elapsed` the whole session's; `final`
 * = the form closed (a page going hidden sends a chunk and carries on, and
 * never counts as an abandon).
 */
export function sessionEvent(s: {
  layoutId: number
  collection: string
  item: string | null
  openSent: boolean
  saved: boolean
  step: string
  steps: Record<string, number>
  total: number
  elapsed: number
  final: boolean
}): FormUsageEvent | null {
  if (!s.saved && !s.openSent && s.elapsed < MIN_SESSION_MS) return null
  if (!s.saved && s.openSent && s.total <= 0) return null
  return {
    layout_id: s.layoutId,
    collection: s.collection,
    item: s.item,
    open: !s.openSent,
    saved: s.saved,
    abandoned_step:
      s.final && s.item == null && !s.saved && s.elapsed >= MIN_ABANDON_MS ? s.step : null,
    steps: s.steps
  }
}
