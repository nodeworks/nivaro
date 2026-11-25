/**
 * Time-zone arithmetic for freeze windows (pure). Every time the Hub stores is UTC; a repeating
 * window ("the last 2 days of every month") is judged on the calendar of the zone it was set in.
 */

/** Whether `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall-clock parts of `ms` in `tz`. */
export function zonedParts(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const out: Record<string, number> = {}
  for (const p of f.formatToParts(new Date(ms)))
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second
  }
}

/** How far `tz` is ahead of UTC at instant `ms`, in ms. */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/**
 * The UTC instant of local midnight on (year, month 1–12, day) in `tz`. Day may overflow the
 * month (day 0 = the last day of the month before, 32 = into the next): Date.UTC normalises it.
 */
export function zonedMidnightUtc(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day)
  let at = guess - offsetAt(guess, tz)
  // Once more at the found instant: a DST change between the guess and midnight moves it.
  at = guess - offsetAt(at, tz)
  return at
}

/** Days in a month (month 1–12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
