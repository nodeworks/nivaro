/**
 * Major US holidays as 'YYYY-MM-DD' keys, on the day they are OBSERVED: a
 * holiday on a Saturday is observed the Friday before, one on a Sunday the
 * Monday after (the US federal rule).
 *
 * Used where "is anyone working today?" matters but nobody has filled in the
 * SLA holiday list (Settings → SLA holidays) — e.g. the stale-import signal
 * (2026-11-16: a daily import that skipped a long weekend is not stale). The
 * SLA holiday list still adds to these; it never has to repeat them.
 *
 * Pure: no app imports.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const key = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** The n-th `weekday` (0=Sun … 6=Sat) of a month (1-12); n = -1 = the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
  return lastDay - ((last - weekday + 7) % 7)
}

/** A fixed-date holiday moved to its observed weekday. */
function observed(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day))
  const dow = d.getUTCDay()
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1)
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1)
  return key(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving and
 *  the day after, Christmas Day — observed dates for one year. */
export function majorUsHolidays(year: number): string[] {
  const thanksgiving = nthWeekday(year, 11, 4, 4)
  return [
    observed(year, 1, 1),
    key(year, 5, nthWeekday(year, 5, 1, -1)),
    observed(year, 7, 4),
    key(year, 9, nthWeekday(year, 9, 1, 1)),
    key(year, 11, thanksgiving),
    key(year, 11, thanksgiving + 1),
    observed(year, 12, 25)
  ]
}

/** Every major holiday from `fromYear` to `toYear` inclusive (next year's New
 *  Year's Day can be observed on Dec 31 of this one, so ask one year past). */
export function majorUsHolidaySet(fromYear: number, toYear: number): Set<string> {
  const out = new Set<string>()
  for (let y = fromYear; y <= toYear; y++) for (const d of majorUsHolidays(y)) out.add(d)
  return out
}
