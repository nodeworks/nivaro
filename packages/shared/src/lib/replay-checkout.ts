/**
 * When a FULL session recording takes its next checkout (a full DOM snapshot).
 *
 * rrweb's `checkoutEveryNms: 60_000` took one on the first event after a minute, whatever
 * that event was. A page that keeps updating itself (a live dashboard, "5 min ago" labels)
 * produces such an event every minute with nobody there, so an idle tab stored a ~1 MB
 * snapshot a minute: a tab left on the EFP home page for ~75 minutes filled the 15 MB
 * per-recording cap ("Recording size cap reached", staging 2026-10-24; 79 snapshots were
 * 86% of its bytes).
 *
 * Now: every minute while someone is using the tab (input in the stream since the last
 * snapshot), every 15 minutes otherwise — often enough that any stretch of the recording
 * still starts from a whole page. Changes in between still record as small mutations.
 * The recorder calls `noteReplayEvent` for each emitted event and takes a snapshot when it
 * answers true.
 */

/** A checkout while someone is using the tab. */
export const REPLAY_CHECKOUT_ACTIVE_MS = 60_000
/** A checkout while nobody is (the page may still be changing by itself). */
export const REPLAY_CHECKOUT_IDLE_MS = 15 * 60_000

// rrweb event type 2 = FullSnapshot, 3 = IncrementalSnapshot; incremental sources that are a
// person at the tab: 1 MouseMove, 2 MouseInteraction, 3 Scroll, 4 ViewportResize, 5 Input,
// 6 TouchMove, 12 Drag, 14 Selection. Mutations (0) and the rest are the page itself.
const FULL_SNAPSHOT = 2
const INCREMENTAL = 3
const INPUT_SOURCES = new Set([1, 2, 3, 4, 5, 6, 12, 14])

export interface ReplayCheckoutState {
  /** When the last full snapshot was emitted (ms). */
  lastFullAt: number
  /** Whether a person did anything since then. */
  interacted: boolean
  /** A snapshot was asked for and has not arrived yet. */
  pending: boolean
}

export function createReplayCheckoutState(now = Date.now()): ReplayCheckoutState {
  return { lastFullAt: now, interacted: false, pending: false }
}

/**
 * Record one emitted event; true = take a checkout now. A full snapshot (any: the first,
 * a checkout, a route-sampling one) restarts the clock.
 */
export function noteReplayEvent(
  state: ReplayCheckoutState,
  event: unknown,
  now = Date.now()
): boolean {
  const e = event as { type?: unknown; data?: { source?: unknown } } | null
  if (e?.type === FULL_SNAPSHOT) {
    state.lastFullAt = now
    state.interacted = false
    state.pending = false
    return false
  }
  if (e?.type === INCREMENTAL && INPUT_SOURCES.has(Number(e.data?.source))) state.interacted = true
  if (state.pending) return false
  const since = now - state.lastFullAt
  const due = state.interacted
    ? since >= REPLAY_CHECKOUT_ACTIVE_MS
    : since >= REPLAY_CHECKOUT_IDLE_MS
  if (due) state.pending = true
  return due
}
