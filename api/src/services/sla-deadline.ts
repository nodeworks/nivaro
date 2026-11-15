import {
  type BusinessSchedule,
  businessHoursElapsed,
  getSlaScheduleSync
} from './business-hours.js'

/**
 * The wall-clock instants an SLA clock turns amber (`warning_at`) and red (`due_at`), so a
 * page can count down to them without asking again (realtime round 2: "due in 1 h 59 m"
 * ticks client-side from these; the server's flip pass announces the same instants).
 *
 * They agree with the status math in routes/sla.ts exactly:
 * - a calendar rule: elapsed = (now - entered) in hours, so the clock crosses `pct` of the
 *   duration at entered + duration × pct / 100;
 * - a business-hours rule: `businessHoursElapsed` counts the hourly steps from `entered`
 *   (entered, entered + 1 h, …) that start inside working time, so elapsed reaches n at the
 *   moment just after the n-th working step begins — the deadline is that step's start + 1 ms.
 *
 * Nothing here reads the database; the schedule is passed in (or the cached one).
 */

const HOUR_MS = 3_600_000
/** Never walk further than this many days ahead looking for working hours (a schedule with
 *  no working days at all would otherwise walk forever). */
const MAX_DAYS = 3 * 366

export interface SlaDeadlines {
  /** When the clock reaches its warning threshold (amber); null without a threshold. */
  warning_at: Date | null
  /** When the clock reaches 100 % (breached). */
  due_at: Date | null
}

/**
 * The instant `businessHoursElapsed(from, t, schedule)` first reaches `hours`. Null when the
 * schedule has no working time within MAX_DAYS. `hours <= 0` = `from` itself (already met).
 */
export function businessHoursDeadline(
  from: Date,
  hours: number,
  schedule: BusinessSchedule = getSlaScheduleSync()
): Date | null {
  if (!Number.isFinite(hours)) return null
  // Elapsed is a whole number of hourly steps: reaching 2.5 h takes the 3rd working step.
  let need = Math.ceil(hours - 1e-9)
  if (need <= 0) return new Date(from.getTime())
  const start = from.getTime()
  const limit = start + MAX_DAYS * 24 * HOUR_MS
  let t = start
  while (t < limit) {
    // Walk at most to the end of the local day; count it in one go when its hours are
    // contiguous (no DST change inside), else step hour by hour — the same split as
    // businessHoursElapsed, so both agree on every step.
    const span = businessHoursElapsed(new Date(t), new Date(t + HOUR_MS), schedule)
    if (span >= 1) {
      need -= 1
      if (need === 0) return new Date(t + 1)
      t += HOUR_MS
      continue
    }
    // A non-working step: skip ahead in bigger strides while nothing in them counts.
    let stride = 8
    while (stride >= 1) {
      const end = t + stride * HOUR_MS
      if (end <= limit && businessHoursElapsed(new Date(t), new Date(end), schedule) === 0) {
        t = end
        break
      }
      stride = Math.floor(stride / 2)
    }
    if (stride < 1) t += HOUR_MS
  }
  return null
}

/** Both instants for one clock (see the header). Null instants when they cannot be told. */
export function slaDeadlines(input: {
  enteredAt: Date | string | null | undefined
  durationHours: number | null | undefined
  warningPct: number | null | undefined
  businessHoursOnly: boolean
  schedule?: BusinessSchedule
}): SlaDeadlines {
  const none: SlaDeadlines = { warning_at: null, due_at: null }
  if (input.enteredAt == null || input.durationHours == null) return none
  const entered = new Date(input.enteredAt)
  const duration = Number(input.durationHours)
  if (!Number.isFinite(entered.getTime()) || !Number.isFinite(duration) || duration <= 0)
    return none
  const pct =
    input.warningPct == null || !Number.isFinite(Number(input.warningPct))
      ? null
      : Number(input.warningPct)
  const warnHours = pct != null && pct < 100 ? (duration * pct) / 100 : null
  if (!input.businessHoursOnly) {
    return {
      warning_at: warnHours != null ? new Date(entered.getTime() + warnHours * HOUR_MS) : null,
      due_at: new Date(entered.getTime() + duration * HOUR_MS)
    }
  }
  const schedule = input.schedule ?? getSlaScheduleSync()
  return {
    warning_at: warnHours != null ? businessHoursDeadline(entered, warnHours, schedule) : null,
    due_at: businessHoursDeadline(entered, duration, schedule)
  }
}

/** ISO strings for a JSON answer (null stays null). */
export function deadlinesJson(d: SlaDeadlines): {
  warning_at: string | null
  due_at: string | null
} {
  return {
    warning_at: d.warning_at ? d.warning_at.toISOString() : null,
    due_at: d.due_at ? d.due_at.toISOString() : null
  }
}
