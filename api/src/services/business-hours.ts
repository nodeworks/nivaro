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

type WallClock = { day: number; hour: number; key: string }

// An instant's wall clock never changes, and every zone's offset is a multiple
// of 15 minutes, so one read serves the whole quarter-hour. SLA ranges in a
// batch overlap (they all end now), so most reads repeat. Bounded; cleared whole.
const QUARTER_MS = 900_000
const WALL_CACHE_MAX = 50_000
const wallCache = new Map<string, Map<number, WallClock>>()
let wallCacheSize = 0

/** The instant's wall clock in the schedule's zone (server-local when unset). */
function wallClock(d: Date, tz: string | null): WallClock {
  const bucket = Math.floor(d.getTime() / QUARTER_MS)
  let zone = wallCache.get(tz ?? '')
  const hit = zone?.get(bucket)
  if (hit) return hit
  const wc = readWallClock(new Date(bucket * QUARTER_MS), tz)
  if (wallCacheSize >= WALL_CACHE_MAX) {
    wallCache.clear()
    wallCacheSize = 0
    zone = undefined
  }
  if (!zone) {
    zone = new Map()
    wallCache.set(tz ?? '', zone)
  }
  zone.set(bucket, wc)
  wallCacheSize++
  return wc
}

function readWallClock(d: Date, tz: string | null): WallClock {
  if (!tz) return { day: d.getDay(), hour: d.getHours(), key: dateKey(d) }
  const parts = zoneFormatter(tz).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    day: WEEKDAY_NUM[get('weekday')] ?? d.getDay(),
    hour: Number(get('hour')),
    key: `${get('year')}-${get('month')}-${get('day')}`
  }
}

const HOUR_MS = 3_600_000

/** Hours between two instants that fall inside the business schedule.
 *  Day/hour/holiday are judged in the SCHEDULE's timezone.
 *
 *  Counts the hourly steps from `from` (from, from+1h, … while < to) whose wall
 *  clock is a working hour. It used to read the wall clock once per step — an
 *  Intl format per hour, thousands per record for an SLA open for months, and
 *  the batch status route's whole CPU. Now each local day is read at its first
 *  and last step: when they agree (same day, hours contiguous) the day's
 *  working hours are counted arithmetically; a day whose clock changes in
 *  between (DST) is walked hour by hour as before. Same result, two reads a
 *  day. */
export function businessHoursElapsed(
  from: Date,
  to: Date,
  schedule: BusinessSchedule = getSlaScheduleSync()
): number {
  const tz = schedule.timeZone
  const working = (wc: { day: number; hour: number; key: string }) =>
    !schedule.holidays.has(wc.key) &&
    schedule.days.has(wc.day) &&
    wc.hour >= schedule.startHour &&
    wc.hour < schedule.endHour
  const end = to.getTime()
  let t = from.getTime()
  let hours = 0
  while (t < end) {
    const wc = wallClock(new Date(t), tz)
    const steps = Math.min(24 - wc.hour, Math.ceil((end - t) / HOUR_MS))
    const last = steps > 1 ? wallClock(new Date(t + (steps - 1) * HOUR_MS), tz) : wc
    if (last.key === wc.key && last.hour === wc.hour + steps - 1) {
      if (!schedule.holidays.has(wc.key) && schedule.days.has(wc.day)) {
        const lo = Math.max(wc.hour, schedule.startHour)
        const hi = Math.min(wc.hour + steps, schedule.endHour)
        if (hi > lo) hours += hi - lo
      }
    } else {
      for (let i = 0; i < steps; i++) if (working(wallClock(new Date(t + i * HOUR_MS), tz))) hours++
    }
    t += steps * HOUR_MS
  }
  return hours
}
