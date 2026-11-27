import type { PlannedItem } from '../../incident/planned.js'
import { firstHandover, WEEK_MS } from '../../incident/rota.js'
import { zonedParts } from '../../releases/zoned.js'

/**
 * Pure helpers that turn Hub data into PagerDuty field values and back. The adapter never reads
 * the Hub's rota or planned maintenance itself (adapters never touch the database): whoever builds
 * the resource (the UI, a hook) fills the schedule's `people` / `handover_*` / `starts_on` fields
 * from the app's Hub rota (`rotaToScheduleFields`) or a maintenance window's fields from a planned
 * freeze (`windowFieldsOfPlanned`).
 */

/** The weekly one-layer schedule a Hub rota becomes. People are EMAIL addresses, in rota order. */
export interface RotaFields {
  people: string[]
  /** 0 = Sunday … 6 = Saturday, on the schedule's time zone. */
  handover_weekday: number
  /** 'HH:MM' on the schedule's time zone. */
  handover_time: string
  /** The day the first person starts (ISO); only decides where the layer begins. */
  starts_on?: string
}

/** The one PagerDuty layer those fields make (canonical: lower-case emails, UTC instant). */
export interface CanonicalLayer {
  people: string[]
  turn_seconds: number
  /** UTC ISO instant the first person's turn starts: one week before the first hand-over. */
  virtual_start: string
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
export const WEEK_SECONDS = WEEK_MS / 1000

export function rotaProblem(f: Partial<RotaFields>): string | null {
  if (!Array.isArray(f.people) || !f.people.length || f.people.length > 20)
    return 'The rota lists 1 to 20 people (by email).'
  if (f.people.some((p) => typeof p !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)))
    return 'Every person in the rota is an email address.'
  const wd = Number(f.handover_weekday)
  if (!Number.isInteger(wd) || wd < 0 || wd > 6)
    return 'The hand-over weekday is 0 (Sunday) to 6 (Saturday).'
  if (!TIME_RE.test(String(f.handover_time ?? ''))) return 'The hand-over time is HH:MM.'
  if (f.starts_on && Number.isNaN(Date.parse(String(f.starts_on))))
    return 'The start date is not a date.'
  return null
}

/** The layer these fields make in the schedule's time zone (check `rotaProblem` first). */
export function layerOfFields(f: RotaFields, timeZone: string, now: Date): CanonicalLayer {
  const first = firstHandover({
    time_zone: timeZone,
    handover_weekday: Number(f.handover_weekday),
    handover_time: f.handover_time,
    starts_on: f.starts_on ?? now.toISOString()
  })
  return {
    people: f.people.map((p) => p.trim().toLowerCase()),
    turn_seconds: WEEK_SECONDS,
    virtual_start: new Date(first - WEEK_MS).toISOString()
  }
}

/** The hand-over weekday and time a PagerDuty layer implies, on the schedule's time zone. */
export function handoverOfLayer(
  virtualStart: string,
  turnSeconds: number,
  timeZone: string
): { weekday: number; time: string } | null {
  const start = Date.parse(virtualStart)
  if (Number.isNaN(start) || !Number.isFinite(turnSeconds) || turnSeconds <= 0) return null
  const p = zonedParts(start + turnSeconds * 1000, timeZone)
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  const pad = (n: number) => String(n).padStart(2, '0')
  return { weekday, time: `${pad(p.hour)}:${pad(p.minute)}` }
}

/** A Hub rota (people already mapped to emails by the caller) as schedule fields. */
export function rotaToScheduleFields(
  rota: { handover_weekday: number; handover_time: string; starts_on: string },
  emails: string[]
): RotaFields {
  return {
    people: emails.map((e) => e.trim().toLowerCase()),
    handover_weekday: rota.handover_weekday,
    handover_time: rota.handover_time,
    starts_on: rota.starts_on
  }
}

/** The `pagerduty.maintenance_window` fields for a planned freeze or maintenance of the Hub. */
export function windowFieldsOfPlanned(
  item: Pick<PlannedItem, 'title' | 'starts_at' | 'ends_at'>,
  fallbackHours = 2
): { start_time: string; end_time: string; description: string } {
  const start = Date.parse(item.starts_at)
  const end = item.ends_at ? Date.parse(item.ends_at) : start + fallbackHours * 3_600_000
  return {
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    description: `Nivaro Hub: ${item.title}`.slice(0, 1024)
  }
}
