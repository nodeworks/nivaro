import { db } from '../db/index.js'

/**
 * The time zone a person reads times in: their own profile setting
 * (preferences.timezone), else the instance's business time zone
 * (nivaro_settings.sla_timezone), else US Eastern. Anything that writes a
 * time FOR a person — the assistant's replies, reminders — goes through here,
 * so nobody is told "00:03:45 UTC".
 */
const FALLBACK_ZONE = 'America/New_York'

function validZone(z: unknown): string | null {
  const s = typeof z === 'string' ? z.trim() : ''
  if (!s) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
    return s
  } catch {
    return null
  }
}

let instanceZone: { value: string; at: number } | null = null

async function instanceTimeZone(): Promise<string> {
  if (instanceZone && Date.now() - instanceZone.at < 60_000) return instanceZone.value
  const row = (await db('nivaro_settings')
    .first('sla_timezone')
    .catch(() => null)) as { sla_timezone?: unknown } | null
  const value = validZone(row?.sla_timezone) ?? FALLBACK_ZONE
  instanceZone = { value, at: Date.now() }
  return value
}

export async function userTimeZone(user: { preferences?: unknown } | null): Promise<string> {
  let prefs: unknown = user?.preferences
  if (typeof prefs === 'string') {
    try {
      prefs = JSON.parse(prefs)
    } catch {
      prefs = null
    }
  }
  const own = validZone((prefs as { timezone?: unknown } | null)?.timezone)
  return own ?? instanceTimeZone()
}

/** "Tue, Sep 29 at 8:03 PM EDT" — 12-hour, in the reader's zone. */
export function formatForPerson(d: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }).format(d)
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(d)
  return `${day} at ${time}`
}

/** The instruction every assistant prompt carries about writing times. */
export function timeInstructions(timeZone: string, now = new Date()): string {
  return `The person you are answering is in the ${timeZone} time zone; it is now ${formatForPerson(now, timeZone)} for them. Write every date and time for them in that zone, in 12-hour form with AM/PM (for example "Tue, Sep 29 at 8:03 PM" or "8:03 PM today") — never UTC, never ISO timestamps, never 24-hour times. When a tool gives a time in UTC or ISO form, convert it before you write it.`
}
