import type { CalendarEvent } from './calendar.js'

/**
 * iCalendar (RFC 5545) for the change calendar's export — pure. Every time is UTC (`…Z`); text is
 * escaped (backslash, semicolon, comma, newline) and lines are folded at 75 octets.
 */

const two = (n: number) => String(n).padStart(2, '0')

export function icsTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
}

export function icsText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Folds one content line at 75 octets (continuation lines start with a space). */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const out: string[] = []
  let cur = ''
  let size = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8')
    const limit = out.length === 0 ? 75 : 74
    if (size + n > limit) {
      out.push(cur)
      cur = ''
      size = 0
    }
    cur += ch
    size += n
  }
  out.push(cur)
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n')
}

/** A whole VCALENDAR of the events (windows — allowed times, not changes — are left out). */
export function renderIcs(
  events: CalendarEvent[],
  o: { name: string; host: string; now?: number }
): string {
  const stamp = icsTime(o.now ?? Date.now())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nivaro//Hub change calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(o.name)}`
  ]
  for (const e of events) {
    if (e.kind === 'window') continue
    const start = Date.parse(e.start)
    if (!Number.isFinite(start)) continue
    const endRaw = e.end ? Date.parse(e.end) : Number.NaN
    const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : start + 15 * 60_000
    const where = [e.app_key, e.env_key].filter(Boolean).join(' · ')
    const desc = [e.detail, where ? `App: ${where}` : null, `Status: ${e.status}`]
      .filter(Boolean)
      .join('\n')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsText(`${e.id}@${o.host}`)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(start)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(e.title)}`,
      `DESCRIPTION:${icsText(desc)}`,
      `CATEGORIES:${icsText(e.kind)}`,
      ...(e.status === 'cancelled' ? ['STATUS:CANCELLED'] : []),
      'END:VEVENT'
    )
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}
