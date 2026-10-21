/**
 * Scheduled huddles (#2860) — the client helpers: the `[huddle:<id>]` marker
 * a card message carries, the calendar file and the Outlook link (no Graph
 * write — the person's own calendar app does the rest), and the time words.
 */

export interface HuddleScheduleCardData {
  id: number
  room: string
  title: string
  starts_at: string
  ends_at: string
  duration_min: number
  status: 'scheduled' | 'cancelled' | 'done'
  organizer: { id: string; name: string | null }
  invitees: Array<{ id: string; name: string | null }>
  live: boolean
  can_cancel: boolean
}

const MARKER_RE = /\[huddle:(\d+)\]/

/** The schedule id a message carries, or null. */
export function huddleRefOf(text: string | null | undefined): number | null {
  const m = text ? MARKER_RE.exec(text) : null
  return m ? Number(m[1]) : null
}

/** The message without its marker (what the bubble shows above the card). */
export function stripHuddleRef(text: string): string {
  return text.replace(MARKER_RE, '').replace(/\s+$/, '')
}

export type SchedulePhase = 'upcoming' | 'soon' | 'live' | 'ended' | 'cancelled'

/** Pure: where a schedule is in its life, for the card's verb. */
export function schedulePhase(
  c: Pick<HuddleScheduleCardData, 'starts_at' | 'ends_at' | 'status'>,
  now = Date.now()
): SchedulePhase {
  if (c.status === 'cancelled') return 'cancelled'
  const start = new Date(c.starts_at).getTime()
  const end = new Date(c.ends_at).getTime()
  if (now >= end) return 'ended'
  if (now >= start) return 'live'
  if (start - now <= 15 * 60_000) return 'soon'
  return 'upcoming'
}

/** "Thu, Oct 23 · 3:00–3:30 PM" in the viewer's clock. */
export function formatScheduleWhen(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt)
  const e = new Date(endsAt)
  if (Number.isNaN(s.getTime())) return ''
  const day = s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${t(s)}–${t(e)}`
}

/** "in 2 h", "in 12 min", "now" — the countdown beside an upcoming card. */
export function formatStartsIn(startsAt: string, now = Date.now()): string {
  const ms = new Date(startsAt).getTime() - now
  if (ms <= 30_000) return 'now'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `in ${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return m ? `in ${h} h ${m} min` : `in ${h} h`
  const d = Math.round(h / 24)
  return `in ${d} day${d === 1 ? '' : 's'}`
}

function icsStamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

/** An RFC 5545 event the person's calendar app imports; `url` opens the room. */
export function buildIcs(c: HuddleScheduleCardData, url: string | null, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nivaro//Huddles//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:nivaro-huddle-${c.id}@${c.room.replace(/[^A-Za-z0-9.-]/g, '-')}`,
    `DTSTAMP:${icsStamp(now.toISOString())}`,
    `DTSTART:${icsStamp(c.starts_at)}`,
    `DTEND:${icsStamp(c.ends_at)}`,
    `SUMMARY:${icsEscape(`Huddle: ${c.title}`)}`,
    `DESCRIPTION:${icsEscape(
      `${c.organizer.name ?? 'Someone'} scheduled a huddle in Nivaro.${url ? ` Join: ${url}` : ''}`
    )}`
  ]
  if (url) lines.push(`URL:${url}`)
  lines.push(
    'BEGIN:VALARM',
    'TRIGGER:-PT5M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(`Huddle in 5 minutes: ${c.title}`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  )
  return `${lines.join('\r\n')}\r\n`
}

/** The Outlook on the web "new event" deep link, pre-filled; no write to anyone's calendar. */
export function outlookComposeUrl(c: HuddleScheduleCardData, url: string | null): string {
  const q = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: `Huddle: ${c.title}`,
    startdt: new Date(c.starts_at).toISOString(),
    enddt: new Date(c.ends_at).toISOString(),
    body: `${c.organizer.name ?? 'Someone'} scheduled a huddle in Nivaro.${url ? ` Join: ${url}` : ''}`
  })
  return `https://outlook.office.com/calendar/0/deeplink/compose?${q.toString()}`
}

/** Trigger a download of the .ics in the browser (a no-op outside one). */
export function downloadIcs(c: HuddleScheduleCardData, url: string | null): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  try {
    const blob = new Blob([buildIcs(c, url)], { type: 'text/calendar;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = `huddle-${c.id}.ics`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  } catch {
    /* a download that fails must never break the room */
  }
}

/** A `datetime-local` value for a Date, in local time (the form's default start). */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The next quarter hour at least 15 minutes away — a sensible default start. */
export function defaultStart(now = new Date()): Date {
  const d = new Date(now.getTime() + 15 * 60_000)
  d.setSeconds(0, 0)
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15)
  return d
}
