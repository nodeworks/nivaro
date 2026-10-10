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
 * Chapters (#1397): the recorder stamps a `route` custom event on every
 * navigation (and once for the page it starts on); each change of page PATH
 * opens a chapter — a query-string change (a filter, ?t=) does not. The player
 * builds the same chapters, adding the server's page trail.
 *
 * The running state (`active_last_ts`, `chapter_last_route`) rides on the
 * row, so the gap or the page that straddles two chunks counts once.
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

export interface ChapterState {
  count: number
  lastRoute: string | null
}

/** '/items/orders?x=1#y' → '/items/orders' — chapters split on the path alone. */
export function routePath(raw: unknown): string {
  return String(raw ?? '')
    .split(/[?#]/)[0]
    .slice(0, 500)
}

/** Fold one chunk's `route` custom events (rrweb type 5) into the chapter count. */
export function foldChapters(state: ChapterState, events: unknown[]): ChapterState {
  const routes = (
    events as Array<{
      type?: unknown
      timestamp?: unknown
      data?: { tag?: unknown; payload?: { path?: unknown } | null } | null
    } | null>
  )
    .filter((e) => e?.type === 5 && e.data?.tag === 'route' && typeof e.timestamp === 'number')
    .sort((a, b) => (a?.timestamp as number) - (b?.timestamp as number))
  let { count, lastRoute } = state
  for (const e of routes) {
    const path = routePath(e?.data?.payload?.path)
    if (!path || path === lastRoute) continue
    count += 1
    lastRoute = path
  }
  return { count, lastRoute }
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
      .first('active_ms', 'active_last_ts', 'chapter_count', 'chapter_last_route')) as
      | Record<string, unknown>
      | undefined
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
    const chBefore: ChapterState = {
      count: num(row.chapter_count) ?? 0,
      lastRoute: row.chapter_last_route == null ? null : String(row.chapter_last_route)
    }
    const chAfter = foldChapters(chBefore, events)
    if (chAfter.count !== chBefore.count || row.chapter_count == null) {
      patch.chapter_count = chAfter.count
    }
    if (chAfter.lastRoute !== chBefore.lastRoute) patch.chapter_last_route = chAfter.lastRoute
    if (Object.keys(patch).length === 0) return
    await db('nivaro_session_recordings').where({ id: recordingId }).update(patch)
  } catch {
    /* stats are decoration — the chunk is already stored */
  }
}
