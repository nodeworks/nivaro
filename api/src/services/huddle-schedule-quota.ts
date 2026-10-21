import { db } from '../db/index.js'
import { TABLE } from './huddle-schedule.js'

/**
 * How many scheduled huddles (#2860) one person may have (security review 2026-10-21,
 * finding 2). Each schedule notifies up to 50 invitees three times (the invite, the
 * reminder, the ring at the start) and arms timers in the API process, so the count of
 * upcoming ones and the pace of making them are both capped per organizer. The hour
 * counts cancelled ones too: making and cancelling in a loop still notifies everyone.
 */

/** Upcoming (scheduled, not started, not cancelled) huddles one person may organize. */
export const OPEN_SCHEDULES_MAX = 20
/** Huddles one person may schedule in an hour. */
export const SCHEDULES_PER_HOUR_MAX = 10

export interface ScheduleQuotaRefusal {
  code: 'HUDDLE_SCHEDULE_OPEN_LIMIT' | 'HUDDLE_SCHEDULE_RATE_LIMIT'
  error: string
}

/** Pure: the refusal for these counts, or null. */
export function scheduleQuotaRefusal(counts: {
  open: number
  lastHour: number
}): ScheduleQuotaRefusal | null {
  if (counts.open >= OPEN_SCHEDULES_MAX) {
    return {
      code: 'HUDDLE_SCHEDULE_OPEN_LIMIT',
      error: `You already have ${OPEN_SCHEDULES_MAX} upcoming huddles. Cancel one before scheduling another.`
    }
  }
  if (counts.lastHour >= SCHEDULES_PER_HOUR_MAX) {
    return {
      code: 'HUDDLE_SCHEDULE_RATE_LIMIT',
      error: `You have scheduled ${SCHEDULES_PER_HOUR_MAX} huddles in the last hour. Try again later.`
    }
  }
  return null
}

function countOf(rows: unknown): number {
  const r = Array.isArray(rows) ? (rows[0] as { n?: unknown } | undefined) : undefined
  return Number(r?.n ?? 0) || 0
}

/** The organizer's two counts (one indexed read each) and the refusal they lead to. */
export async function scheduleQuota(
  userId: string,
  now = new Date()
): Promise<ScheduleQuotaRefusal | null> {
  const [open, lastHour] = await Promise.all([
    db(TABLE)
      .where({ created_by: userId, status: 'scheduled' })
      .where('starts_at', '>', now)
      .count({ n: '*' }),
    db(TABLE)
      .where({ created_by: userId })
      .where('created_at', '>', new Date(now.getTime() - 3600_000))
      .count({ n: '*' })
  ])
  return scheduleQuotaRefusal({ open: countOf(open), lastHour: countOf(lastHour) })
}
