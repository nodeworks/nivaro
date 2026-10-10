/**
 * Follow a record across recordings (#1398) — the pure half of "Play all":
 * which stretch of each recording to play, in what order, and which revision
 * of the record each stretch was looking at.
 */

/** A recording that touched the record (a replay search hit, #1374). */
export interface RecordVisit {
  id: string
  user: string | null
  user_name: string | null
  /** When the record's route was first / last seen in this recording (epoch ms). */
  first_ms: number
  last_ms: number
}

export interface PlaySegment {
  recordingId: string
  person: string
  /** Wall-clock window to play (epoch ms). */
  from: number
  to: number
  /** The visit itself, unpadded. */
  visitFrom: number
  visitTo: number
}

/** Minutes either side of the visit — what led to it and what followed. */
export const SEGMENT_PAD_MS = 60_000
/** A stitched timeline longer than this many segments is cut (oldest kept). */
export const MAX_SEGMENTS = 50

/**
 * One segment per recording, trimmed to the visit plus SEGMENT_PAD_MS either
 * side, oldest first. Two people on the record at once give two segments in
 * the order they arrived.
 */
export function planSegments(visits: RecordVisit[], padMs = SEGMENT_PAD_MS): PlaySegment[] {
  return visits
    .filter((v) => Number.isFinite(v.first_ms) && Number.isFinite(v.last_ms))
    .map((v) => {
      const a = Math.min(v.first_ms, v.last_ms)
      const b = Math.max(v.first_ms, v.last_ms)
      return {
        recordingId: v.id,
        person: v.user_name?.trim() || v.user?.slice(0, 8) || 'Unknown',
        from: a - padMs,
        to: b + padMs,
        visitFrom: a,
        visitTo: b
      }
    })
    .sort((x, y) => x.visitFrom - y.visitFrom || x.recordingId.localeCompare(y.recordingId))
    .slice(0, MAX_SEGMENTS)
}

/** The bits of a revision the segment strip reads (lib/api Revision). */
export interface RevisionLike {
  id: number | string | null
  activity: number | null
  timestamp: string | null
}

function revMs(r: RevisionLike): number {
  return r.timestamp ? Date.parse(r.timestamp) : Number.NaN
}

/** The revision in effect at `ms`: the latest saved at or before it. */
export function revisionAt<R extends RevisionLike>(revisions: R[], ms: number): R | null {
  let best: R | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  for (const r of revisions) {
    const t = revMs(r)
    if (!Number.isFinite(t) || t > ms || t < bestMs) continue
    best = r
    bestMs = t
  }
  return best
}

/** Revisions saved inside [from, to], oldest first — the edits a segment shows. */
export function revisionsWithin<R extends RevisionLike>(
  revisions: R[],
  from: number,
  to: number
): R[] {
  return revisions
    .filter((r) => {
      const t = revMs(r)
      return Number.isFinite(t) && t >= from && t <= to
    })
    .sort((a, b) => revMs(a) - revMs(b))
}

/** "4m 05s" / "45s". */
export function fmtLength(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * Playback crossed a segment's end (an offset) between two frames. The
 * player moves `prev` along with every seek, so scrubbing past the end lands
 * beyond it without crossing it and never trips it.
 */
export function crossedEnd(prev: number, cur: number, endOffset: number): boolean {
  return prev < endOffset && cur >= endOffset
}
