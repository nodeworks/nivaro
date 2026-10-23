import { Liquid } from 'liquidjs'
import { db } from '../db/index.js'
import {
  currentTimezone,
  dayInZone,
  instanceTimezone,
  useZonedDates,
  zonedDay
} from './liquid-dates.js'

// ─── Payload filters ─────────────────────────────────────────────────────────
// The payload-template filters as plain functions (the field-map evaluator and
// the render entry call them directly) plus `registerPayloadFilters`, which
// wraps them for Liquid. The day helpers count in the instance zone
// (liquid-dates.ts); with no database they count Eastern days.

let blackoutCache: { dates: Set<string>; loadedAt: number } | null = null
async function blackoutDates(): Promise<Set<string>> {
  if (blackoutCache && Date.now() - blackoutCache.loadedAt < 300_000) return blackoutCache.dates
  const dates = new Set<string>()
  try {
    const rows = (await db('nivaro_blackout_dates').select('date')) as Array<{ date: unknown }>
    for (const r of rows) {
      const d = new Date(String(r.date))
      if (!Number.isNaN(d.getTime())) dates.add(d.toISOString().slice(0, 10))
    }
  } catch {
    /* table missing — no blackouts */
  }
  blackoutCache = { dates, loadedAt: Date.now() }
  return dates
}

/**
 * The calendar day a value names, as yyyy-MM-dd. A date-only string — or an
 * exact UTC midnight, which is how SQL `date` columns arrive — is that day; a
 * timestamp is the day it falls on in `zone` (the process zone when omitted);
 * nothing at all is today. Days are counted on the calendar, never by adding
 * hours: the old filter moved a local clock and printed it in UTC, which was
 * a day off in the evening and across a daylight-saving change. The payload
 * filters pass the instance zone, so a UTC container still counts Eastern days.
 */
export function calendarDay(v: unknown, now: Date = new Date(), zone?: string): string | null {
  const day = (d: Date) =>
    zone
      ? dayInZone(d, zone)
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (v == null || v === '') return day(now)
  if (zone) return zonedDay(v, zone)
  const raw = v instanceof Date ? v : String(v).trim()
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const d = raw instanceof Date ? raw : new Date(raw)
  return Number.isNaN(d.getTime()) ? null : day(d)
}

export function addCalendarDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + (Number.isFinite(n) ? Math.trunc(n) : 0)))
  return t.toISOString().slice(0, 10)
}

/** `date` + n calendar days as yyyy-MM-dd (instance zone). An unreadable date comes back as given. */
export function addDays(date: string | Date, n: number): string {
  const day = calendarDay(date, new Date(), currentTimezone())
  if (!day) return date as string
  return addCalendarDays(day, Number(n ?? 0))
}

/** `date` when it is at least `n` days from today, else today + n (a missing date counts as none). */
export function atLeastDaysOut(date: string | Date | null, n: number): string {
  const zone = currentTimezone()
  const min = addCalendarDays(calendarDay(undefined, new Date(), zone) as string, Number(n ?? 0))
  const day = date == null || date === '' ? null : calendarDay(date, new Date(), zone)
  // yyyy-MM-dd compares as text.
  return day && day >= min ? day : min
}

/** The first weekday on or after `date` that is not a blackout date. */
export async function nextOpenDay(date: string): Promise<string> {
  const blocked = await blackoutDates()
  let iso =
    date == null || (date as unknown) === ''
      ? null
      : calendarDay(date, new Date(), await instanceTimezone())
  if (!iso) return date
  for (let i = 0; i < 60; i++) {
    const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay()
    if (weekday !== 0 && weekday !== 6 && !blocked.has(iso)) return iso
    iso = addCalendarDays(iso, 1)
  }
  return iso
}

/** Left-pad to a fixed width; longer input is unchanged, a missing value is "". */
export function padStart(v: unknown, n: number, ch: string): string {
  if (v == null) return ''
  const str = String(v).trim()
  const w = Number(n ?? 0)
  if (!Number.isFinite(w) || w <= str.length) return str
  return str.padStart(w, String(ch ?? '0').slice(0, 1) || '0')
}

/** Editor.js document JSON → plain text; HTML notes are stripped; other strings pass through. */
export function editorText(v: unknown): string {
  const raw = String(v ?? '')
  try {
    const doc = JSON.parse(raw) as { blocks?: Array<{ data?: { text?: string } }> }
    if (!Array.isArray(doc.blocks)) return raw
    return doc.blocks
      .map((b) => String(b?.data?.text ?? ''))
      .filter(Boolean)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    // Post-conversion notes are HTML — strip to plain text the same way an
    // EditorJS doc's inline markup was stripped.
    if (/^\s*</.test(raw)) {
      return raw
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
    }
    return raw
  }
}

/** The calendar day a value names as yyyy-MM-dd, or null when empty/unreadable. */
export function isoDate(v: unknown): string | null {
  if (v == null || v === '') return null
  return calendarDay(v, new Date(), currentTimezone())
}

/** JSON.stringify anything — undefined/missing renders as null. */
export function jsonify(v: unknown): string {
  return JSON.stringify(v ?? null)
}

export function registerPayloadFilters(engine: Liquid): void {
  engine.registerFilter('add_days', async (v: unknown, n: unknown) => {
    const day = calendarDay(v, new Date(), await instanceTimezone())
    if (!day) return v
    return addCalendarDays(day, Number(n ?? 0))
  })
  // JSON.stringify anything — undefined/missing renders as null, keeping
  // generated JSON payloads valid without per-field if-guards.
  engine.registerFilter('jsonify', (v: unknown) => jsonify(v))
  // Editor.js document JSON → plain text: paragraph/header block texts joined with
  // spaces, HTML tags stripped. Non-editorjs strings pass through unchanged.
  engine.registerFilter('editorjs_text', (v: unknown) => editorText(v))
  engine.registerFilter('iso_date', async (v: unknown) => {
    if (v == null || v === '') return ''
    return calendarDay(v, new Date(), await instanceTimezone()) ?? ''
  })
  engine.registerFilter('at_least_days_out', async (v: unknown, n: unknown) => {
    const zone = await instanceTimezone()
    const min = addCalendarDays(calendarDay(undefined, new Date(), zone) as string, Number(n ?? 0))
    const day = v == null || v === '' ? null : calendarDay(v, new Date(), zone)
    // yyyy-MM-dd compares as text.
    return day && day >= min ? day : min
  })
  engine.registerFilter('next_open_day', (v: unknown) => nextOpenDay(v as string))
  // Left-pad to a fixed width: `{{ sku | pad_start: 9, '0' }}` → "000106416".
  // Longer input is returned unchanged; a missing value renders as "" so a
  // partner's schema check names the real problem instead of "000000null".
  engine.registerFilter('pad_start', (v: unknown, width: unknown, fill: unknown = '0') =>
    padStart(v, Number(width ?? 0), String(fill ?? '0'))
  )
}

let shared: Liquid | null = null
/** The one shared payload Liquid engine (filters registered, zoned dates applied). */
export function payloadLiquid(): Liquid {
  if (!shared) {
    shared = new Liquid({ strictFilters: false, strictVariables: false })
    registerPayloadFilters(shared)
    useZonedDates(shared)
  }
  return shared
}
