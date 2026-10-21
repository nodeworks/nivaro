/**
 * The DM composer's quiet note (#2484): when you write to someone outside their
 * working hours, say what time it is for them. Pure — ChatPanel feeds it the
 * peer's presence row and the clock.
 */

export interface PeerTimeInfo {
  timezone: string | null
  working_hours?: { start: string; end: string } | null
}

const DEFAULT_HOURS = { start: '08:00', end: '18:00' }

/** Local weekday (0 = Sunday) and "HH:MM" for an instant in an IANA zone. */
function localParts(zone: string, now: Date): { day: number; hhmm: string; label: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
    const hh = get('hour') === '24' ? '00' : get('hour')
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit'
    }).format(now)
    return day < 0 ? null : { day, hhmm: `${hh}:${get('minute')}`, label }
  } catch {
    return null
  }
}

/** True when `now` falls outside the person's working hours (weekends always do). */
export function isOutsideWorkingHours(info: PeerTimeInfo, now: Date): boolean | null {
  if (!info.timezone) return null
  const p = localParts(info.timezone, now)
  if (!p) return null
  if (p.day === 0 || p.day === 6) return true
  const h = info.working_hours ?? DEFAULT_HOURS
  return p.hhmm < h.start || p.hhmm >= h.end
}

/** "It is 11:40 PM for Ana, outside their working hours." — or null when no note is due. */
export function offHoursNote(info: PeerTimeInfo | null, name: string, now: Date): string | null {
  if (!info?.timezone) return null
  if (isOutsideWorkingHours(info, now) !== true) return null
  const p = localParts(info.timezone, now)
  if (!p) return null
  const first = name.split(/\s+/)[0] || name
  return `It is ${p.label} for ${first}, outside their working hours. They will see this when they are back.`
}
