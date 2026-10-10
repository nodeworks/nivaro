/**
 * Skip inactivity (#1358) — the pure half. A recording left open while the
 * person read, thought or went for coffee is mostly nothing; the player finds
 * every stretch longer than SKIP_GAP_MS with no input and no DOM mutation and
 * crosses it at SKIP_SPEED, labelling each on the scrubber ("skipped 2m 10s").
 *
 * rrweb's own `skipInactive` is not used: it only counts user interaction
 * (a page that updates itself on screen is "inactive" to it), it waits 10 s,
 * scales its speed with the gap, and says nothing about where it skipped.
 *
 * The server's active-time stat (api/src/services/session-replay-stats.ts)
 * uses the same threshold and the same events, so a recording's "active"
 * time on the list matches what the player plays at normal speed.
 */

/** A gap longer than this with no activity is skipped. */
export const SKIP_GAP_MS = 5_000
/** Speed across a skipped gap. */
export const SKIP_SPEED = 8
/**
 * Crossing more than this at 8× would sit on a still frame for several
 * seconds; the player jumps instead, to SKIP_TAIL_MS before the gap ends.
 */
export const SKIP_JUMP_REMAINING_MS = 30_000
export const SKIP_TAIL_MS = 2_000
/** Leave the gap this much before its end so normal speed resumes on the next event. */
const END_LEAD_MS = 250

/**
 * rrweb incremental sources that count as activity: Mutation 0, MouseMove 1,
 * MouseInteraction 2, Scroll 3, ViewportResize 4, Input 5, TouchMove 6,
 * MediaInteraction 7, Drag 12, Selection 14.
 */
const ACTIVE_SOURCES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 12, 14])

type EventLike = {
  type?: unknown
  timestamp?: unknown
  data?: { source?: unknown; [k: string]: unknown } | null
} | null

/** Full snapshots, meta (navigation) and input / mutation incrementals. */
export function isActivityEvent(e: EventLike): boolean {
  if (!e || typeof e.timestamp !== 'number') return false
  if (e.type === 2 || e.type === 4) return true
  return e.type === 3 && ACTIVE_SOURCES.has(Number(e.data?.source))
}

export interface InactiveGap {
  /** ms into the recording where the last activity before the gap happened. */
  start: number
  /** ms into the recording of the next activity (or the recording's end). */
  end: number
}

/**
 * Every stretch longer than `threshold` with no activity, as offsets from
 * `first`. A quiet tail (the tab left open until the recording closed) is a
 * gap too; a quiet start is not — the first snapshot is activity.
 */
export function findInactiveGaps(
  events: unknown[],
  first: number,
  threshold = SKIP_GAP_MS
): InactiveGap[] {
  let lastTs = Number.NEGATIVE_INFINITY
  const active: number[] = []
  for (const e of events as EventLike[]) {
    const t = typeof e?.timestamp === 'number' ? e.timestamp : null
    if (t == null) continue
    if (t > lastTs) lastTs = t
    if (isActivityEvent(e)) active.push(t)
  }
  if (active.length === 0) return []
  active.sort((a, b) => a - b)
  const gaps: InactiveGap[] = []
  for (let i = 1; i < active.length; i++) {
    if (active[i] - active[i - 1] > threshold) {
      gaps.push({ start: active[i - 1] - first, end: active[i] - first })
    }
  }
  const tailFrom = active[active.length - 1]
  if (lastTs - tailFrom > threshold) gaps.push({ start: tailFrom - first, end: lastTs - first })
  return gaps
}

/** The gap the playhead is inside (and not about to leave), or null. Gaps sorted by start. */
export function gapAt(gaps: InactiveGap[], time: number): InactiveGap | null {
  let lo = 0
  let hi = gaps.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const g = gaps[mid]
    if (time < g.start) hi = mid - 1
    else if (time >= g.end - END_LEAD_MS) lo = mid + 1
    else return g
  }
  return null
}

export interface SkipDecision {
  gap: InactiveGap | null
  /** Speed the replayer should run at right now. */
  speed: number
  /** Jump here at once (a long gap); null = just play on. */
  seekTo: number | null
}

/** What the player does at `time`: normal speed, 8× across a gap, or a jump over a long one. */
export function skipDecision(
  gaps: InactiveGap[],
  time: number,
  userSpeed: number,
  enabled: boolean
): SkipDecision {
  const gap = enabled ? gapAt(gaps, time) : null
  if (!gap) return { gap: null, speed: userSpeed, seekTo: null }
  const remaining = gap.end - time
  const seekTo = remaining > SKIP_JUMP_REMAINING_MS ? gap.end - SKIP_TAIL_MS : null
  return { gap, speed: Math.max(SKIP_SPEED, userSpeed), seekTo }
}

/** '2m 10s', '45s', '1h 3m' — the scrubber's "skipped …" label. */
export function fmtSkip(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Total time the gaps cover. */
export function skippedTotal(gaps: InactiveGap[]): number {
  return gaps.reduce((n, g) => n + (g.end - g.start), 0)
}
