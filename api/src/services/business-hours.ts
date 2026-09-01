import { db } from '../db/index.js'

/**
 * Single source of truth for SLA business-hours math.
 *
 * The schedule lives on the settings singleton: sla_business_day_start/end
 * (hours), sla_business_days ('1,2,3,4,5'), sla_holidays (JSON array of
 * 'YYYY-MM-DD'). Holiday dates count zero business hours regardless of
 * weekday.
 *
 * Two access modes:
 *  - getSlaSchedule()      async, 60s cache — status endpoints, hooks, crons
 *  - getSlaScheduleSync()  last-loaded value (defaults until first load),
 *                          kicks off a background refresh — for sync hot
 *                          paths like the materialized-queue row math
 */

export interface BusinessSchedule {
  startHour: number
  endHour: number
  days: Set<number> // 0=Sun … 6=Sat
  holidays: Set<string> // 'YYYY-MM-DD'
  /** IANA zone the schedule is expressed in. NULL = the server's own zone —
   *  which in a deployed container is UTC, so set this. */
  timeZone: string | null
}

const DEFAULT_SCHEDULE: BusinessSchedule = {
  startHour: 9,
  endHour: 17,
  days: new Set([1, 2, 3, 4, 5]),
  holidays: new Set(),
  timeZone: null
}

let cached: BusinessSchedule = DEFAULT_SCHEDULE
let cachedAt = 0
let loading: Promise<BusinessSchedule> | null = null
const TTL = 60_000

async function loadSchedule(): Promise<BusinessSchedule> {
  const row = await db('nivaro_settings')
    .first(
      'sla_business_day_start',
      'sla_business_day_end',
      'sla_business_days',
      'sla_holidays',
      'sla_timezone'
    )
    .catch(() => null)
  const days = ((row?.sla_business_days as string | null) ?? '1,2,3,4,5')
    .split(',')
    .map(Number)
    .filter((n) => !Number.isNaN(n))
  let holidays: string[] = []
  if (row?.sla_holidays) {
    try {
      const parsed = JSON.parse(String(row.sla_holidays))
      if (Array.isArray(parsed)) holidays = parsed.filter((d) => typeof d === 'string')
    } catch {
      /* malformed — no holidays */
    }
  }
  let timeZone: string | null = null
  const tzRaw = String((row as { sla_timezone?: unknown } | null)?.sla_timezone ?? '').trim()
  if (tzRaw) {
    try {
      // Throw-test the zone — a typo must degrade to server-local, not crash
      // every SLA computation.
      new Intl.DateTimeFormat('en-US', { timeZone: tzRaw })
      timeZone = tzRaw
    } catch {
      timeZone = null
    }
  }
  cached = {
    startHour: (row?.sla_business_day_start as number | null) ?? 9,
    endHour: (row?.sla_business_day_end as number | null) ?? 17,
    days: new Set(days),
    holidays: new Set(holidays),
    timeZone
  }
  cachedAt = Date.now()
  return cached
}

export async function getSlaSchedule(): Promise<BusinessSchedule> {
  if (Date.now() - cachedAt < TTL) return cached
  if (!loading) {
    loading = loadSchedule().finally(() => {
      loading = null
    })
  }
  return loading
}

/** Last-loaded schedule (defaults before first load); refreshes in the background. */
export function getSlaScheduleSync(): BusinessSchedule {
  if (Date.now() - cachedAt >= TTL && !loading) {
    loading = loadSchedule()
      .catch(() => cached)
      .finally(() => {
        loading = null
      })
  }
  return cached
}

export function clearScheduleCache(): void {
  cachedAt = 0
}

function dateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const WEEKDAY_NUM: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      hourCycle: 'h23'
    })
    zoneFormatters.set(tz, f)
  }
  return f
}

/** The instant's wall clock in the schedule's zone (server-local when unset). */
function wallClock(
  d: Date,
  tz: string | null
): { day: number; hour: number; key: string } {
  if (!tz) return { day: d.getDay(), hour: d.getHours(), key: dateKey(d) }
  const parts = zoneFormatter(tz).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    day: WEEKDAY_NUM[get('weekday')] ?? d.getDay(),
    hour: Number(get('hour')),
    key: `${get('year')}-${get('month')}-${get('day')}`
  }
}

/** Hours between two instants that fall inside the business schedule.
 *  Day/hour/holiday are judged in the SCHEDULE's timezone. */
export function businessHoursElapsed(
  from: Date,
  to: Date,
  schedule: BusinessSchedule = getSlaScheduleSync()
): number {
  let hours = 0
  const current = new Date(from)
  while (current < to) {
    const wc = wallClock(current, schedule.timeZone)
    if (
      !schedule.holidays.has(wc.key) &&
      schedule.days.has(wc.day) &&
      wc.hour >= schedule.startHour &&
      wc.hour < schedule.endHour
    ) {
      hours++
    }
    current.setTime(current.getTime() + 3_600_000)
  }
  return hours
}
