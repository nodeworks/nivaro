/**
 * Range selection on the replay scrubber (#1366, #1415, #1362) — pure pieces:
 * pointer position → time, drag → ordered range, handle nudges. Times are ms
 * from the recording's first event, the player's clock and the server's.
 */

export type ReplayRange = [number, number]

/** The shortest range the server accepts. */
export const MIN_RANGE_MS = 1_000

/** Pointer x inside a track → ms, clamped to the recording. */
export function msAtX(x: number, left: number, width: number, total: number): number {
  if (!(width > 0) || !(total > 0)) return 0
  const f = Math.min(1, Math.max(0, (x - left) / width))
  return Math.round(f * total)
}

/** A drag from `anchor` to `ms`, either direction. */
export function dragRange(anchor: number, ms: number): ReplayRange {
  return anchor <= ms ? [anchor, ms] : [ms, anchor]
}

/**
 * Move one end of a range, keeping it inside the recording and at least
 * MIN_RANGE_MS long (the other end gives way at the edges).
 */
export function moveEdge(
  range: ReplayRange,
  edge: 'start' | 'end',
  ms: number,
  total: number
): ReplayRange {
  const min = Math.min(MIN_RANGE_MS, total)
  const t = Math.min(total, Math.max(0, Math.round(ms)))
  if (edge === 'start') {
    const start = Math.min(t, total - min)
    return [start, Math.max(range[1], start + min)]
  }
  const end = Math.max(t, min)
  return [Math.min(range[0], end - min), end]
}

/** A range worth acting on. */
export function usableRange(range: ReplayRange | null): range is ReplayRange {
  return !!range && range[1] - range[0] >= MIN_RANGE_MS
}

/** "28 s", "2 m 05 s". */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`
}

/** "in 3 days", "in 5 hours", "in 20 minutes" — a share link's expiry (#1362). */
export function expiresIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now
  if (!Number.isFinite(ms)) return '—'
  if (ms <= 0) return 'expired'
  const mins = Math.ceil(ms / 60_000)
  const plural = (n: number, w: string) => `in ${n} ${w}${n === 1 ? '' : 's'}`
  if (mins < 60) return plural(mins, 'minute')
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return plural(hrs, 'hour')
  return plural(Math.round(hrs / 24), 'day')
}
