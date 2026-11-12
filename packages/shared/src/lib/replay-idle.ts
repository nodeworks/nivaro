/**
 * When a FULL session recording stops because nobody is at the tab.
 *
 * A recording used to run for as long as its tab was open. A page keeps changing by itself
 * (live widgets, "5 min ago" labels, presence), so a tab nobody was looking at uploaded about
 * a chunk a minute, day and night: on production (2026-11-12) 7 to 16 people's tabs sent 400
 * to 900 chunks an hour between 1 and 4 AM, and a machine that lost its network overnight
 * queued hours of it and sent the backlog in one burst the next morning.
 *
 * Now: after REPLAY_IDLE_PAUSE_MS without input in the stream (a hidden tab gets none) the
 * recorder records nothing. The first input brings it back: it takes a full snapshot, and
 * recording goes on from that snapshot, since the changes in between were not kept. After a
 * break of REPLAY_IDLE_RESTART_MS or more the recorder starts a new recording instead of
 * adding to the old one (what follows a long break is another session, and the server may
 * have moved a recording that went quiet to cold storage).
 *
 * The recorder calls `noteReplayIdle` for every emitted event, before anything else:
 * - 'keep'   record the event
 * - 'drop'   do not record it
 * - 'resume' do not record it, and take a full snapshot now (`state.idleMs` says how long
 *            the tab had been without input)
 */
import { isReplayInputEvent } from './replay-checkout'

/** Without input for this long, the recording pauses. */
export const REPLAY_IDLE_PAUSE_MS = 5 * 60_000
/** Back after a break this long, the recorder starts a new recording. */
export const REPLAY_IDLE_RESTART_MS = 30 * 60_000
/** How long events wait for the resume snapshot before recording goes on without it. */
export const REPLAY_IDLE_RESUME_WAIT_MS = 15_000

// rrweb event types: 2 FullSnapshot, 4 Meta (emitted just before each full snapshot).
const FULL_SNAPSHOT = 2
const META = 4

export interface ReplayIdleState {
  /** When a person last did something in the tab (ms). */
  lastInputAt: number
  /** When recording paused for idleness; 0 while it records. */
  pausedAt: number
  /** When the resume snapshot was asked for; 0 when none is awaited. */
  awaitingSince: number
  /** How long the tab had been without input at the last 'resume' (ms). */
  idleMs: number
}

export type ReplayIdleAction = 'keep' | 'drop' | 'resume'

export function createReplayIdleState(now = Date.now()): ReplayIdleState {
  return { lastInputAt: now, pausedAt: 0, awaitingSince: 0, idleMs: 0 }
}

export function noteReplayIdle(
  state: ReplayIdleState,
  event: unknown,
  now = Date.now()
): ReplayIdleAction {
  const input = isReplayInputEvent(event)
  if (state.awaitingSince) {
    if (input) state.lastInputAt = now
    const type = (event as { type?: unknown } | null)?.type
    if (type === FULL_SNAPSHOT) {
      state.awaitingSince = 0
      return 'keep'
    }
    if (type === META) return 'keep'
    // Anything else before the snapshot refers to a page the recording never saw.
    if (now - state.awaitingSince < REPLAY_IDLE_RESUME_WAIT_MS) return 'drop'
    // The snapshot never came: a recording with a rough start beats none.
    state.awaitingSince = 0
    return 'keep'
  }
  if (state.pausedAt) {
    if (!input) return 'drop'
    state.idleMs = now - state.lastInputAt
    state.pausedAt = 0
    state.lastInputAt = now
    state.awaitingSince = now
    return 'resume'
  }
  if (input) {
    state.lastInputAt = now
    return 'keep'
  }
  if (now - state.lastInputAt >= REPLAY_IDLE_PAUSE_MS) {
    state.pausedAt = now
    return 'drop'
  }
  return 'keep'
}
