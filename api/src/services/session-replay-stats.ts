import { db } from '../db/index.js'

/**
 * Per-recording replay stats, kept up to date chunk by chunk as the recorder
 * uploads (POST /session-recordings/:id/events) so the list can show and sort
 * by them without decoding a single chunk.
 *
 * Active time (#1358): the sum of the gaps between consecutive ACTIVITY events
 * — DOM mutations and the person's own input (mouse, scroll, keys, touch,
 * resize, media, selection, drag) plus snapshots — each gap capped at 5 s. A
 * recording left open over lunch is a few minutes of activity, not an hour.
 * The player's skip-inactivity uses the same threshold and the same events.
 *
 * The running state (`active_last_ts`) rides on the row, so the gap that
 * straddles two chunks counts once.
 */

/** Gaps longer than this are inactivity — same constant as the player's skip. */
export const ACTIVE_GAP_CAP_MS = 5_000

/**
 * rrweb incremental-snapshot sources that mean "something happened":
 * Mutation 0, MouseMove 1, MouseInteraction 2, Scroll 3, ViewportResize 4,
 * Input 5, TouchMove 6, MediaInteraction 7, Drag 12, Selection 14. Stylesheet,
 * canvas and font traffic (8–11, 13, 15+) is the page's own churn.
 */
const ACTIVE_SOURCES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 12, 14])

type EventLike = {
  type?: unknown
  timestamp?: unknown
  data?: { source?: unknown; [k: string]: unknown } | null
} | null

/** rrweb event types: 2 FullSnapshot, 3 IncrementalSnapshot, 4 Meta. */
export function isActivityEvent(e: EventLike): boolean {
  if (!e || typeof e.timestamp !== 'number') return false
  if (e.type === 2 || e.type === 4) return true
  if (e.type !== 3) return false
  return ACTIVE_SOURCES.has(Number(e.data?.source))
}

export interface ActiveState {
  activeMs: number
  lastTs: number | null
}

/**
 * Fold one chunk into the running active-time state. Events may arrive a
 * little out of order (rrweb batches by source); they are sorted first, and a
 * timestamp at or before `lastTs` adds nothing.
 */
export function foldActiveTime(state: ActiveState, events: unknown[]): ActiveState {
  const ts = (events as EventLike[])
    .filter(isActivityEvent)
    .map((e) => (e as { timestamp: number }).timestamp)
    .sort((a, b) => a - b)
  let { activeMs, lastTs } = state
  for (const t of ts) {
    if (lastTs != null) {
      const gap = t - lastTs
      if (gap <= 0) continue
      activeMs += Math.min(gap, ACTIVE_GAP_CAP_MS)
    }
    lastTs = t
  }
  return { activeMs, lastTs }
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Called once per stored chunk. Never fails the upload: an install behind
 * migration 420 (no stats columns) or a transient write error only loses the
 * stat, never the chunk.
 */
export async function recordChunkStats(recordingId: string, events: unknown[]): Promise<void> {
  try {
    const row = (await db('nivaro_session_recordings')
      .where({ id: recordingId })
      .first('active_ms', 'active_last_ts')) as Record<string, unknown> | undefined
    if (!row) return
    const before: ActiveState = {
      activeMs: num(row.active_ms) ?? 0,
      lastTs: num(row.active_last_ts)
    }
    const after = foldActiveTime(before, events)
    const patch: Record<string, unknown> = {}
    if (after.activeMs !== before.activeMs || row.active_ms == null) {
      patch.active_ms = Math.min(after.activeMs, 2_147_483_647)
    }
    if (after.lastTs !== before.lastTs) patch.active_last_ts = after.lastTs
    if (Object.keys(patch).length === 0) return
    await db('nivaro_session_recordings').where({ id: recordingId }).update(patch)
  } catch {
    /* stats are decoration — the chunk is already stored */
  }
}
