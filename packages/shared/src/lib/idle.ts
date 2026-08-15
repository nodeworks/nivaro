/**
 * Whether the person is actually at the machine.
 *
 * `last_seen` cannot answer this — the heartbeat keeps beating while a tab sits
 * open in the background — so idleness is a client observation and every host
 * that writes presence has to report it. It lives here rather than in each app
 * because it did not: admin reported it and efp-new did not, so a row marked
 * idle by one never cleared in the other and the person stayed idle forever.
 *
 * Call `trackActivity()` once at startup, then include `idleState()` in each
 * heartbeat payload.
 */

/** Time without real input before someone counts as idle. */
export const IDLE_AFTER_MS = 5 * 60_000

/**
 * Events that mean a person is there. Deliberately includes mousemove and
 * scroll: reading a long record without clicking anything is being present,
 * and treating it as absence is how someone "goes idle while active".
 * mousemove fires constantly, so it is throttled rather than listened to raw.
 */
const ACTIVITY_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
  'mousemove',
  'focus'
] as const

let lastActivity = Date.now()
let installed = false

/** Install the listeners. Safe to call more than once. */
export function trackActivity(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  let throttle = 0
  const mark = () => {
    const now = Date.now()
    // A pointer sweep fires hundreds of events; one update a second is plenty
    // to keep someone marked present.
    if (now - throttle < 1000) return
    throttle = now
    lastActivity = now
  }

  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, mark, { passive: true, capture: true })
  }

  document.addEventListener('visibilitychange', () => {
    // Switching away IS the signal — waiting out the timeout would report
    // someone as present when they demonstrably are not. Coming back counts as
    // activity immediately, which is what lets idle clear on the next beat.
    if (document.visibilityState === 'visible') {
      lastActivity = Date.now()
      throttle = 0
    } else {
      lastActivity = 0
    }
  })
}

/** The fields a presence heartbeat should carry. */
export function idleState(): { is_idle: boolean; last_active: string } {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const stale = Date.now() - lastActivity > IDLE_AFTER_MS
  return {
    is_idle: hidden || stale,
    last_active: new Date(lastActivity || Date.now()).toISOString()
  }
}
