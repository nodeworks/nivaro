/**
 * Zoned `date` filter for every server-side Liquid engine (mail, PDFs,
 * workflow-action payloads, inbound mappings).
 *
 * Liquid's built-in `date` formats in the process timezone — UTC in the
 * container — so a 9:20 AM Eastern transition printed "1:20 PM" and anything
 * after 8 PM Eastern landed on tomorrow. This filter formats timestamps in
 * the instance zone (nivaro_settings.default_timezone, the zone the admin
 * displays in; Eastern when unset) while calendar dates — 'yyyy-MM-dd'
 * strings and exact UTC midnights, which is how SQL `date` columns arrive —
 * keep the day they name instead of sliding back to the previous evening.
 * An explicit zone argument (`| date: '%H:%M', 'Europe/London'`) still wins.
 */
import { filters, type Liquid } from 'liquidjs'
import { db } from '../db/index.js'

export const FALLBACK_TIMEZONE = 'America/New_York'

let zoneCache: { at: number; zone: string } | null = null

function validZone(zone: unknown): string | null {
  const z = typeof zone === 'string' ? zone.trim() : ''
  if (!z) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return z
  } catch {
    return null
  }
}

let zoneRead: Promise<string> | null = null

/** The instance display zone, re-read every 60s. */
export async function instanceTimezone(): Promise<string> {
  if (zoneCache && Date.now() - zoneCache.at < 60_000) return zoneCache.zone
  zoneRead ??= readZone().finally(() => {
    zoneRead = null
  })
  return zoneRead
}

/** The instance zone for synchronous callers (rule evaluators): the cached
 *  value — Eastern until the first read lands — refreshed in the background
 *  once stale. */
export function currentTimezone(): string {
  if (!zoneCache || Date.now() - zoneCache.at >= 60_000) void instanceTimezone()
  return zoneCache?.zone ?? FALLBACK_TIMEZONE
}

async function readZone(): Promise<string> {
  let zone = FALLBACK_TIMEZONE
  try {
    const row = (await db('nivaro_settings').first('default_timezone')) as
      | { default_timezone?: string | null }
      | undefined
    zone = validZone(row?.default_timezone) ?? FALLBACK_TIMEZONE
  } catch {
    // Column may not exist yet mid-migration — keep the fallback.
  }
  zoneCache = { at: Date.now(), zone }
  return zone
}

const DAY_MS = 86_400_000

/** A value that names a calendar day rather than an instant: a date-only
 *  string, or midnight that is UTC or carries no zone at all. */
export function isCalendarDate(v: unknown): boolean {
  if (v instanceof Date) return v.getTime() % DAY_MS === 0
  if (typeof v !== 'string') return false
  const s = v.trim()
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{4}-\d{2}-\d{2}[T ]00:00:00(\.0+)?(Z|[+-]00:?00)?$/.test(s)
  )
}

/** The yyyy-MM-dd day an instant falls on in `zone`. */
export function dayInZone(d: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/** The yyyy-MM-dd day a value names: a date-only string, a UTC midnight (SQL
 *  `date`) or a zone-less date-time keeps the day written; any other instant
 *  is the day it falls on in `zone`. Null when there is no readable date. */
export function zonedDay(v: unknown, zone: string): string | null {
  if (v == null || v === '') return null
  const raw = v instanceof Date ? v : String(v).trim()
  if (typeof raw === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(raw) || NAIVE_DATETIME.test(raw)))
    return raw.slice(0, 10)
  const d = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  if (isCalendarDate(raw)) return d.toISOString().slice(0, 10)
  return dayInZone(d, zone)
}

/** Calendar days from today to the day `v` names, both read in `zone`
 *  (0 = today, negative = past), or null when `v` has no readable date. */
export function daysFromToday(
  v: unknown,
  zone: string = currentTimezone(),
  now: Date = new Date()
): number | null {
  const day = zonedDay(v, zone)
  if (!day) return null
  const today = dayInZone(now, zone)
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)
}

/** Replace the engine's `date` filter with the zoned one. Async, so only for
 *  engines rendered with parseAndRender / renderFile (never the Sync APIs). */
export function useZonedDates(engine: Liquid): Liquid {
  const builtin = filters.date as unknown as (
    this: unknown,
    v: unknown,
    format?: string,
    tz?: number | string
  ) => string
  engine.registerFilter(
    'date',
    async function (this: unknown, v: unknown, format?: string, tz?: any) {
      if (tz !== undefined && tz !== null && tz !== '') return builtin.call(this, v, format, tz)
      if (isCalendarDate(v)) return builtin.call(this, v, format, 0)
      return builtin.call(this, v, format, await instanceTimezone())
    }
  )
  return engine
}
