/**
 * The report window: one instance day, from the start hour to the end hour, in the instance's
 * time zone (nivaro_settings.sla_timezone, else the server's own zone).
 */
import { db } from '../../db/index.js'

export interface ReportWindow {
  /** The instance day, YYYY-MM-DD. */
  day: string
  start: Date
  end: Date
  tz: string
}

export function validZone(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
    return s
  } catch {
    return null
  }
}

export async function instanceZone(): Promise<string> {
  const row = (await db('nivaro_settings')
    .first('sla_timezone')
    .catch(() => null)) as { sla_timezone?: unknown } | null
  return validZone(row?.sla_timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
}

/** Milliseconds the zone is ahead of UTC at `at` (negative west of Greenwich). */
export function zoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(at)
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const asUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour') % 24,
    n('minute'),
    n('second')
  )
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The instant `hour`:00 on `day` in `tz` (hour 24 = midnight after). */
export function zonedInstant(day: string, hour: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour)
  let at = guess - zoneOffsetMs(new Date(guess), tz)
  // Once more across a DST change between the guess and the answer.
  at = guess - zoneOffsetMs(new Date(at), tz)
  return new Date(at)
}

/** The instance day `at` falls on, YYYY-MM-DD. */
export function dayIn(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(at)
}

/** The hour of the instance day `at` falls on (0–23). */
export function hourIn(at: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(at)
  )
}

export function isDay(raw: unknown): raw is string {
  return (
    typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw))
  )
}

export function reportWindow(
  day: string,
  startHour: number,
  endHour: number,
  tz: string
): ReportWindow {
  return { day, start: zonedInstant(day, startHour, tz), end: zonedInstant(day, endHour, tz), tz }
}

/** "2:09 PM" in the instance zone — how times are written in the report. */
export function clock(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit'
  }).format(at)
}
