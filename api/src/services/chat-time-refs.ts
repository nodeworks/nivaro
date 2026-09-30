/**
 * Time chips (#962): times written in a chat message ("tomorrow 3pm",
 * "Oct 2 9:00", "Friday at noon") are read at SEND time, in the sender's own
 * zone, into stored instants. Each reader then sees the same moment in their
 * own zone — "3pm" from someone in Denver reads as 5:00 PM in New York.
 *
 * Pure: the only inputs are the text, the sender's IANA zone and "now".
 * A phrase is only recognised when it has a clock time; a bare day ("see you
 * Friday") is left alone, because turning it into a midnight would be wrong.
 */

export interface TimeRef {
  /** The exact substring of the message, as the sender wrote it. */
  text: string
  /** ISO instant the phrase means. */
  at: string
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]

const DAY_WORD =
  '(?:today|tonight|tomorrow|(?:next\\s+)?(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))'
const MONTH_WORD =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const DATE_PART = `(?:${MONTH_WORD}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}\\/\\d{1,2})`
const DAY_PART = `(?:${DAY_WORD}|(?:${DAY_WORD},?\\s+)?${DATE_PART})`
const CLOCK_12 = '\\d{1,2}(?::[0-5]\\d)?\\s?(?:am|pm|a\\.m\\.|p\\.m\\.)'
const CLOCK_24 = '(?:[01]?\\d|2[0-3]):[0-5]\\d'
const CLOCK = `(?:${CLOCK_12}|${CLOCK_24}|noon|midnight)`

/** "<day> [at] <time>", "<time> <day>", or a lone time. */
const PHRASE = new RegExp(
  `\\b(?:(${DAY_PART})\\s+(?:at\\s+)?(${CLOCK})|(${CLOCK})\\s+(?:on\\s+)?(${DAY_PART})|(${CLOCK}))(?![\\w:])`,
  'gi'
)

interface WallDate {
  y: number
  m: number
  d: number
}

function partsIn(instant: Date, zone: string): WallDate & { h: number; mi: number; wd: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'long',
    hour12: false
  })
  const p: Record<string, string> = {}
  for (const x of fmt.formatToParts(instant)) p[x.type] = x.value
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    wd: WEEKDAYS.indexOf(String(p.weekday).toLowerCase())
  }
}

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetMinutes(instant: Date, zone: string): number {
  const p = partsIn(instant, zone)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi)
  return Math.round((asUtc - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000)
}

/** A wall-clock time in a zone → the instant it names (DST-aware). */
export function zonedToInstant(w: WallDate, h: number, mi: number, zone: string): Date {
  const guess = Date.UTC(w.y, w.m - 1, w.d, h, mi)
  let off = offsetMinutes(new Date(guess), zone)
  let at = guess - off * 60_000
  const off2 = offsetMinutes(new Date(at), zone)
  if (off2 !== off) {
    off = off2
    at = guess - off * 60_000
  }
  return new Date(at)
}

function addDays(w: WallDate, n: number): WallDate {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

function parseClock(raw: string): { h: number; mi: number } | null {
  const s = raw.toLowerCase().replace(/\./g, '').replace(/\s+/g, '')
  if (s === 'noon') return { h: 12, mi: 0 }
  if (s === 'midnight') return { h: 0, mi: 0 }
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/)
  if (!m) return null
  let h = Number(m[1])
  const mi = m[2] ? Number(m[2]) : 0
  if (m[3]) {
    if (h < 1 || h > 12) return null
    if (m[3] === 'pm' && h !== 12) h += 12
    if (m[3] === 'am' && h === 12) h = 0
  } else if (!m[2]) {
    return null // a bare "3" is a number, not a time
  }
  if (h > 23 || mi > 59) return null
  return { h, mi }
}

function parseDay(raw: string, today: WallDate & { wd: number }): WallDate | null {
  const s = raw.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
  if (s === 'today' || s === 'tonight') return today
  if (s === 'tomorrow') return addDays(today, 1)
  // "Oct 2" / "October 2nd" (optionally preceded by a weekday), or "10/2".
  const md = s.match(new RegExp(`(${MONTH_WORD})\\.?\\s+(\\d{1,2})`, 'i'))
  if (md) {
    const month = MONTHS.findIndex((n) => n.startsWith(md[1].toLowerCase().slice(0, 3))) + 1
    return nearestDate(today, month, Number(md[2]))
  }
  const slash = s.match(/(\d{1,2})\/(\d{1,2})/)
  if (slash) return nearestDate(today, Number(slash[1]), Number(slash[2]))
  const next = s.startsWith('next ')
  const name = s.replace(/^next\s+/, '')
  const wd = WEEKDAYS.findIndex((n) => n.startsWith(name.slice(0, 3)))
  if (wd < 0) return null
  let diff = (wd - today.wd + 7) % 7
  if (diff === 0) diff = 7 // "Friday" said on a Friday means next week
  if (next && diff < 7) diff += 7
  return addDays(today, diff)
}

/** A month/day with no year: this year, or next year when it already passed. */
function nearestDate(today: WallDate, month: number, day: number): WallDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const thisYear = { y: today.y, m: month, d: day }
  const t = Date.UTC(today.y, month - 1, day)
  const now = Date.UTC(today.y, today.m - 1, today.d)
  return t < now - 30 * 86_400_000 ? { ...thisYear, y: today.y + 1 } : thisYear
}

/** Find every time phrase in a message. Capped — this is decoration. */
export function parseTimeRefs(text: string, zone: string, now = new Date()): TimeRef[] {
  if (!text || text.length > 4000) return []
  const today = partsIn(now, zone)
  const out: TimeRef[] = []
  for (const m of text.matchAll(PHRASE)) {
    const dayRaw = m[1] ?? m[4] ?? null
    const clockRaw = m[2] ?? m[3] ?? m[5]
    if (!clockRaw) continue
    // A lone 24-hour "12:30" inside a longer number run ("v1.12:30") is noise;
    // require a word boundary before it, which the regex already did.
    const clock = parseClock(clockRaw)
    if (!clock) continue
    let day: WallDate | null = today
    if (dayRaw) day = parseDay(dayRaw, today)
    if (!day) continue
    if (/^tonight/i.test(dayRaw ?? '') && clock.h < 12) clock.h += 12
    const at = zonedToInstant(day, clock.h, clock.mi, zone)
    out.push({ text: m[0], at: at.toISOString() })
    if (out.length >= 5) break
  }
  return out
}
