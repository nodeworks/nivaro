/**
 * "Idle for 3m 12s" while following a session live: how long since the person last did
 * something in the tab (clicked, typed, scrolled, moved the mouse or a finger).
 *
 * A page keeps changing by itself (live widgets, "5 min ago" labels), so only INPUT events
 * count — the same test the recorder uses (`isReplayInputEvent`). Event timestamps come from
 * the person's own clock; company machines keep NTP time, so the viewer's clock is used as is,
 * except when an event arrives stamped AHEAD of the viewer's clock (theirs runs fast) — then
 * that lead is taken off so the readout never sticks at "Active now". The stream's own age
 * can't be used for skew: a stream that went quiet because nobody is there would read as lag.
 * After five idle minutes the recorder stops sending anything
 * (packages/shared replay-idle.ts), so the stream going quiet is itself a sign of idleness —
 * the clock keeps counting from the last input.
 */
import { isReplayInputEvent, REPLAY_IDLE_PAUSE_MS } from '@nivaro/shared'

export interface LiveIdleState {
  /** Newest input event (person's clock, ms); 0 = none seen yet. */
  lastInputTs: number
  /** Viewer clock minus the person's clock: 0, or negative when theirs runs ahead. */
  skewMs: number
}

export function createLiveIdle(): LiveIdleState {
  return { lastInputTs: 0, skewMs: 0 }
}

/** Note a batch of events that just arrived (`viewerNow` = the viewer's Date.now()). */
export function noteLiveEvents(state: LiveIdleState, events: unknown[], viewerNow: number): void {
  let newest = 0
  for (const e of events) {
    const ts = (e as { timestamp?: unknown } | null)?.timestamp
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
    if (ts > newest) newest = ts
    if (isReplayInputEvent(e) && ts > state.lastInputTs) state.lastInputTs = ts
  }
  if (!newest) return
  const skew = viewerNow - newest
  if (skew < state.skewMs) state.skewMs = skew
}

/** Milliseconds since the person's last input, on the viewer's clock; null = unknown. */
export function liveIdleMs(state: LiveIdleState, viewerNow: number): number | null {
  if (!state.lastInputTs) return null
  return Math.max(0, viewerNow - state.skewMs - state.lastInputTs)
}

/** Under this, the person reads as active ("Active now"). */
export const LIVE_ACTIVE_MS = 15_000

export interface LiveIdleLabel {
  tone: 'active' | 'idle' | 'away'
  text: string
  tip: string
}

function dur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function liveIdleLabel(idleMs: number | null): LiveIdleLabel | null {
  if (idleMs == null) return null
  if (idleMs < LIVE_ACTIVE_MS)
    return {
      tone: 'active',
      text: 'Active now',
      tip: 'Clicked, typed, scrolled or moved the mouse in the last few seconds.'
    }
  if (idleMs < REPLAY_IDLE_PAUSE_MS)
    return {
      tone: 'idle',
      text: `Idle ${dur(idleMs)}`,
      tip: 'No clicks, typing, scrolling or mouse movement for this long. The page may still be on screen.'
    }
  return {
    tone: 'away',
    text: `Idle ${dur(idleMs)}`,
    tip: 'No input for over 5 minutes, so their recording is paused. It resumes the moment they click, type or move the mouse.'
  }
}
