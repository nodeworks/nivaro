/**
 * Pure layout math for the People page "Day" view (#1367): where on a
 * horizontal timeline an instant or a span lands, how overlapping spans stack
 * into rows, which hours the day was active, and how per-minute request counts
 * fold into bars wide enough to see. No React, no clock — every function takes
 * the times it needs, so the tests can pin them.
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** The stretch of time the track shows, epoch milliseconds, end exclusive. */
export interface TimeView {
  start: number
  end: number
}

/**
 * The viewer's UTC offset at local midnight of `date` (YYYY-MM-DD), in minutes
 * as getTimezoneOffset() gives it (UTC − local: 120 for UTC−2, −60 for UTC+1).
 * Midnight, not noon: on a daylight-saving day the day starts on the old offset.
 */
export function localDayOffset(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).getTimezoneOffset()
}

/** YYYY-MM-DD of a Date in the viewer's own calendar. */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The calendar day `days` away from `date`, both YYYY-MM-DD. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const x = new Date(Date.UTC(y, m - 1, d + days))
  return x.toISOString().slice(0, 10)
}

/** Where `t` sits on the track, as a percentage clamped to 0–100. */
export function pct(t: number, view: TimeView): number {
  const span = view.end - view.start
  if (span <= 0) return 0
  return Math.min(100, Math.max(0, ((t - view.start) / span) * 100))
}

/**
 * Left and width (percent) of a span clipped to the view, at least `minWidth`
 * wide so a two-second page is still something to hover; null when the span
 * lies wholly outside the view. A span pinned at the right edge grows leftward
 * instead of spilling past it.
 */
export function segmentBox(
  start: number,
  end: number,
  view: TimeView,
  minWidth = 0.35
): { left: number; width: number } | null {
  const e = Math.max(start, end)
  if (e < view.start || start >= view.end) return null
  let left = pct(start, view)
  let width = Math.max(minWidth, pct(e, view) - left)
  if (left + width > 100) {
    width = Math.min(width, 100)
    left = 100 - width
  }
  return { left, width }
}

/**
 * Greedy interval partitioning: each span (in input order after a stable sort
 * by start) takes the first row whose last span has ended. Returns the row
 * index per input span (same order as given) and how many rows were needed.
 * `gap` keeps spans that merely touch apart, so adjacent bars stay readable.
 */
export function packRows(
  spans: ReadonlyArray<{ start: number; end: number }>,
  gap = 0
): { rows: number[]; count: number } {
  const order = spans.map((s, i) => ({ s, i })).sort((a, b) => a.s.start - b.s.start || a.i - b.i)
  const rowEnds: number[] = []
  const rows = new Array<number>(spans.length).fill(0)
  for (const { s, i } of order) {
    const end = Math.max(s.start, s.end)
    let row = rowEnds.findIndex((e) => e + gap <= s.start)
    if (row === -1) {
      row = rowEnds.length
      rowEnds.push(end)
    } else {
      rowEnds[row] = end
    }
    rows[i] = row
  }
  return { rows, count: Math.max(1, rowEnds.length) }
}

/**
 * The hours worth showing: from the hour before the first thing to the hour
 * after the last, at least `minHours` wide, never outside the day. The whole
 * day when nothing happened.
 */
export function activeSpan(times: ReadonlyArray<number>, day: TimeView, minHours = 2): TimeView {
  const inside = times.filter((t) => Number.isFinite(t) && t >= day.start && t < day.end)
  if (inside.length === 0) return { ...day }
  const first = Math.min(...inside)
  const last = Math.max(...inside)
  // Whole hours counted from the day's own start, so a +05:30 viewer gets
  // their own hours, not UTC's.
  const dayHours = Math.round((day.end - day.start) / HOUR_MS)
  let sh = Math.floor((first - day.start) / HOUR_MS)
  let eh = Math.min(dayHours, Math.ceil((last - day.start) / HOUR_MS))
  if (eh <= sh) eh = Math.min(dayHours, sh + 1)
  // Grow both ways, an hour at a time, until wide enough or the whole day.
  while (eh - sh < minHours && (sh > 0 || eh < dayHours)) {
    if (sh > 0) sh--
    if (eh - sh < minHours && eh < dayHours) eh++
  }
  return { start: day.start + sh * HOUR_MS, end: Math.min(day.end, day.start + eh * HOUR_MS) }
}

/**
 * Hour ticks across the view: every hour when it fits, else every 2, 3, 4 or 6
 * hours so no more than `maxTicks` labels crowd the axis. Ticks fall on whole
 * hours counted from the day's start.
 */
export function hourTicks(view: TimeView, dayStart: number, maxTicks = 13): number[] {
  const hours = (view.end - view.start) / HOUR_MS
  const step = [1, 2, 3, 4, 6].find((s) => hours / s + 1 <= maxTicks) ?? 6
  const out: number[] = []
  const firstHour = Math.ceil((view.start - dayStart) / HOUR_MS)
  for (let h = firstHour; dayStart + h * HOUR_MS <= view.end; h++) {
    if (h % step === 0) out.push(dayStart + h * HOUR_MS)
  }
  return out
}

export interface MinuteCount {
  /** Start of the minute, ISO. */
  minute: string
  count: number
  errors: number
}
export interface RequestBin {
  start: number
  end: number
  count: number
  errors: number
}

/**
 * Per-minute request counts folded into bins of whole minutes, so a full day
 * on a narrow track draws ~maxBins bars instead of 1,440 sub-pixel ones. Bins
 * line up on the view's start; empty bins are left out.
 */
export function binRequests(
  minutes: ReadonlyArray<MinuteCount>,
  view: TimeView,
  maxBins = 240
): { bins: RequestBin[]; binMinutes: number } {
  const spanMin = Math.max(1, Math.round((view.end - view.start) / MINUTE_MS))
  const binMinutes = Math.max(1, Math.ceil(spanMin / maxBins))
  const size = binMinutes * MINUTE_MS
  const byBin = new Map<number, RequestBin>()
  for (const m of minutes) {
    const t = Date.parse(m.minute)
    if (!Number.isFinite(t) || t < view.start || t >= view.end) continue
    const idx = Math.floor((t - view.start) / size)
    const bin = byBin.get(idx) ?? {
      start: view.start + idx * size,
      end: Math.min(view.end, view.start + (idx + 1) * size),
      count: 0,
      errors: 0
    }
    bin.count += Number(m.count) || 0
    bin.errors += Number(m.errors) || 0
    byBin.set(idx, bin)
  }
  return { bins: [...byBin.values()].sort((a, b) => a.start - b.start), binMinutes }
}

/**
 * The recording that covers `t` (latest-starting wins when two overlap), and
 * how far into it `t` falls — the replay page's `&t=` offset in milliseconds.
 */
export function recordingAt<R extends { start: string; end: string }>(
  recordings: ReadonlyArray<R>,
  t: number,
  slackMs = 0
): { recording: R; offsetMs: number } | null {
  let best: R | null = null
  let bestStart = -Infinity
  for (const r of recordings) {
    const s = Date.parse(r.start)
    const e = Date.parse(r.end)
    if (!Number.isFinite(s)) continue
    const end = Number.isFinite(e) ? Math.max(s, e) : s
    if (t >= s - slackMs && t <= end + slackMs && s > bestStart) {
      best = r
      bestStart = s
    }
  }
  return best ? { recording: best, offsetMs: Math.max(0, t - bestStart) } : null
}

/** An admin path a link may navigate to: rooted, not protocol-relative, no scheme. */
export function isSafeAdminPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes(':')
}
