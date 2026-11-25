import { zonedParts } from './zoned.js'

/**
 * Weekly time ranges (deploy windows, Hub enhancement 27) on the calendar of one IANA zone —
 * pure. A range is a set of weekdays (1 = Monday … 7 = Sunday, ISO) and a wall-clock time span
 * `from`–`to` (HH:MM, `to` may be 24:00). A `to` at or before `from` crosses midnight into the
 * next day (22:00–06:00). Times are kept as wall-clock in the zone, never as UTC: "7 AM Eastern"
 * stays 7 AM across a DST change. Every instant answered is UTC (ms).
 */

export interface WeeklyRange {
  days: number[]
  from: string
  to: string
}

export interface Span {
  start: number
  end: number
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/

export function isHhmm(v: unknown): v is string {
  return typeof v === 'string' && HHMM.test(v)
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * The UTC instant of wall-clock (year, month 1–12, day, minute of day) in `tz`.
 *
 * A DST change makes a wall time missing or doubled; `side` says which way to lean:
 *   - a time in the spring-forward GAP (02:30 in New York on the March change) does not exist:
 *     a window START moves to the LATER candidate (the first instant after the gap, 03:30 EDT),
 *     an END to the earlier one — a window never opens early and never closes late;
 *   - a time in the fall-back OVERLAP (01:30 on the November change) exists twice: both sides
 *     take the first occurrence.
 * The candidates are the wall time read with the zone's offset a day before and a day after;
 * one of them is the real instant whenever the time exists.
 */
export function zonedTimeUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  tz: string,
  side: 'start' | 'end' = 'start'
): number {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay)
  const offsetAt = (ms: number) => {
    const p = zonedParts(ms, tz)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    return asUtc - Math.floor(ms / 1000) * 1000
  }
  const want = new Date(guess)
  const shows = (ms: number) => {
    const p = zonedParts(ms, tz)
    return (
      p.year === want.getUTCFullYear() &&
      p.month === want.getUTCMonth() + 1 &&
      p.day === want.getUTCDate() &&
      p.hour === want.getUTCHours() &&
      p.minute === want.getUTCMinutes()
    )
  }
  const candidates = [
    ...new Set([guess - offsetAt(guess - 86_400_000), guess - offsetAt(guess + 86_400_000)])
  ].sort((a, b) => a - b)
  const real = candidates.filter(shows)
  if (real.length) return real[0]
  // The gap: no candidate shows the wall time.
  return side === 'start' ? candidates[candidates.length - 1] : candidates[0]
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
export function isoWeekday(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return d === 0 ? 7 : d
}

/** Joins spans that touch or overlap (Mon 22:00–24:00 + Tue 00:00–06:00 is one span). */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/**
 * The spans of `ranges` that overlap [from, to), merged. Walks the zone's calendar days from two
 * days before `from` (a range crossing midnight starts the day before) to `to`.
 */
export function weeklySpans(ranges: WeeklyRange[], tz: string, from: number, to: number): Span[] {
  if (!ranges.length || to <= from) return []
  const out: Span[] = []
  const first = zonedParts(from - 2 * 86_400_000, tz)
  // At most ~70 days are ever asked for (the calendar's range is capped); guard anyway.
  for (let i = 0; i < 400; i++) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + i))
    const y = date.getUTCFullYear()
    const m = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    const dayStart = zonedTimeUtc(y, m, d, 0, tz)
    if (dayStart >= to) break
    const wd = isoWeekday(y, m, d)
    for (const r of ranges) {
      if (!r.days.includes(wd)) continue
      const a = minutes(r.from)
      const b = minutes(r.to)
      const start = zonedTimeUtc(y, m, d, a, tz, 'start')
      const end =
        b > a ? zonedTimeUtc(y, m, d, b, tz, 'end') : zonedTimeUtc(y, m, d + 1, b, tz, 'end')
      if (end > from && start < to && end > start) out.push({ start, end })
    }
  }
  return mergeSpans(out)
}

/** The weekly span holding `now`, or null. */
export function weeklySpanAt(ranges: WeeklyRange[], tz: string, now: number): Span | null {
  for (const s of weeklySpans(ranges, tz, now - 8 * 86_400_000, now + 8 * 86_400_000))
    if (now >= s.start && now < s.end) return s
  return null
}

/** The next weekly span starting after `now` (within 15 days), or null. */
export function weeklyNextSpan(ranges: WeeklyRange[], tz: string, now: number): Span | null {
  for (const s of weeklySpans(ranges, tz, now, now + 15 * 86_400_000)) if (s.start > now) return s
  return null
}

const DAY_WORDS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function daysWords(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b)
  if (set.length === 7) return 'Every day'
  if (set.join() === '1,2,3,4,5') return 'Weekdays'
  if (set.join() === '6,7') return 'Weekends'
  // Runs of three or more read as a span (Mon–Thu).
  const parts: string[] = []
  let i = 0
  while (i < set.length) {
    let j = i
    while (j + 1 < set.length && set[j + 1] === set[j] + 1) j++
    parts.push(
      j - i >= 2
        ? `${DAY_WORDS[set[i]]}–${DAY_WORDS[set[j]]}`
        : set
            .slice(i, j + 1)
            .map((d) => DAY_WORDS[d])
            .join(', ')
    )
    i = j + 1
  }
  return parts.join(', ')
}

function timeWords(hhmm: string): string {
  if (hhmm === '24:00' || hhmm === '00:00') return 'midnight'
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m ? `${h12}:${String(m).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`
}

/** "Weekdays 7 AM–5 PM" — one range in words (the zone is said once by the caller). */
export function rangeWords(r: WeeklyRange): string {
  return `${daysWords(r.days)} ${timeWords(r.from)}–${timeWords(r.to)}`
}

/** Validates a ranges list; answers the clean list or a message. */
export function validateRanges(v: unknown): WeeklyRange[] | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: 'ranges needs at least one range' }
  if (v.length > 14) return { error: 'at most 14 ranges' }
  const out: WeeklyRange[] = []
  for (const raw of v) {
    const r = raw as Record<string, unknown> | null
    if (!r || typeof r !== 'object') return { error: 'each range is {days, from, to}' }
    const days = Array.isArray(r.days) ? r.days.map(Number) : []
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
      return { error: 'days are 1 (Monday) to 7 (Sunday)' }
    if (!isHhmm(r.from) || !isHhmm(r.to)) return { error: 'from and to are HH:MM (24-hour)' }
    if (r.from === '24:00') return { error: 'from is 00:00 to 23:59' }
    if (r.from === r.to) return { error: 'a range needs a length (from and to differ)' }
    out.push({ days: [...new Set(days)].sort((a, b) => a - b), from: r.from, to: r.to })
  }
  return out
}
