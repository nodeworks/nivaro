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
}

const DEFAULT_SCHEDULE: BusinessSchedule = {
  startHour: 9,
  endHour: 17,
  days: new Set([1, 2, 3, 4, 5]),
  holidays: new Set()
}

let cached: BusinessSchedule = DEFAULT_SCHEDULE
let cachedAt = 0
let loading: Promise<BusinessSchedule> | null = null
const TTL = 60_000

async function loadSchedule(): Promise<BusinessSchedule> {
  const row = await db('nivaro_settings')
    .first('sla_business_day_start', 'sla_business_day_end', 'sla_business_days', 'sla_holidays')
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
  cached = {
    startHour: (row?.sla_business_day_start as number | null) ?? 9,
    endHour: (row?.sla_business_day_end as number | null) ?? 17,
    days: new Set(days),
    holidays: new Set(holidays)
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

/** Hours between two instants that fall inside the business schedule. */
export function businessHoursElapsed(
  from: Date,
  to: Date,
  schedule: BusinessSchedule = getSlaScheduleSync()
): number {
  let hours = 0
  const current = new Date(from)
  let currentKey = dateKey(current)
  let isHoliday = schedule.holidays.has(currentKey)
  while (current < to) {
    const day = current.getDay()
    const hour = current.getHours()
    if (!isHoliday && schedule.days.has(day) && hour >= schedule.startHour && hour < schedule.endHour) {
      hours++
    }
    current.setHours(current.getHours() + 1)
    if (current.getHours() === 0 || schedule.holidays.size > 0) {
      const k = dateKey(current)
      if (k !== currentKey) {
        currentKey = k
        isHoliday = schedule.holidays.has(k)
      }
    }
  }
  return hours
}
