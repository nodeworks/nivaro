import { useQuery } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { PersonProfile } from './types'

type Hours = { start: number; end: number }

/** Hour-of-day (fractional, UTC) → "9 AM" / "9:30 AM" in the viewer's zone. */
function localHourLabel(utcHour: number, now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, Math.round(utcHour * 60))
  )
  const withMinutes = d.getMinutes() !== 0
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    ...(withMinutes ? { minute: '2-digit' } : {})
  })
}

function zoneAbbrev(now: Date): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')
  return part?.value ?? ''
}

/** Overlap in hours of two daily windows given in UTC hours (end may pass 24). */
export function overlapHours(a: Hours, b: Hours): number {
  const span = (h: Hours) => (h.end >= h.start ? h : { start: h.start, end: h.end + 24 })
  const x = span(a)
  const y = span(b)
  let total = 0
  for (const shift of [-24, 0, 24]) {
    total += Math.max(0, Math.min(x.end, y.end + shift) - Math.max(x.start, y.start + shift))
  }
  return Math.min(24, total)
}

/** Hours from `nowUtc` (fractional hour) until the window next opens; 0 inside it. */
export function hoursUntilWindow(nowUtc: number, h: Hours): number {
  const w = h.end >= h.start ? h : { start: h.start, end: h.end + 24 }
  for (const t of [nowUtc, nowUtc + 24]) if (t >= w.start && t <= w.end) return 0
  let wait = w.start - nowUtc
  while (wait < 0) wait += 24
  return wait
}

/** The viewer's own working window in UTC: their rhythm, else 9–5 local. */
function viewerWindow(own: Hours | null, now: Date): Hours {
  if (own) return own
  const offsetH = -now.getTimezoneOffset() / 60
  return { start: 9 - offsetH, end: 17 - offsetH }
}

export interface ReachSummary {
  hours: string
  overlap: number | null
  when: string | null
}

export function reachSummary(
  p: Pick<PersonProfile, 'typical_hours_utc' | 'is_out_of_office' | 'ooo_end' | 'presence'>,
  own: Hours | null,
  now = new Date()
): ReachSummary | null {
  const t = p.typical_hours_utc
  if (!t) return null
  const hours =
    `${localHourLabel(t.start, now)}–${localHourLabel(t.end, now)} ${zoneAbbrev(now)}`.trim()
  const overlap = Math.round(overlapHours(t, viewerWindow(own, now)) * 2) / 2
  let when: string | null = null
  if (p.is_out_of_office) {
    when = p.ooo_end
      ? `out until ${new Date(p.ooo_end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : 'out of office'
  } else if (p.presence.online) {
    when = 'online now'
  } else {
    const wait = hoursUntilWindow(now.getUTCHours() + now.getUTCMinutes() / 60, t)
    when =
      wait === 0
        ? 'usually around now'
        : wait < 1
          ? 'usually back within the hour'
          : `usually back in ~${Math.round(wait)}h`
  }
  return { hours, overlap, when }
}

/**
 * #639 — "Usually online 9 AM–4 PM EDT · overlaps your day 6h · back in ~2h".
 * The window is the middle 80% of the hours they act in (8 weeks), shown in
 * the viewer's zone; the overlap is against the viewer's own rhythm, or a
 * 9-to-5 day when they have none yet.
 */
export function BestTimeChip({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const { data: own } = useQuery<Hours | null>({
    queryKey: ['nvr-my-rhythm'],
    queryFn: () =>
      client
        .request<{ data: { typical_hours_utc: Hours | null } }>(get('/users/me/stats'))
        .then((r) => r.data.typical_hours_utc ?? null)
        .catch(() => null),
    enabled: !!p.typical_hours_utc,
    staleTime: 30 * 60_000
  })
  const s = reachSummary(p, own ?? null)
  if (!s) return null
  const first = p.first_name ?? p.name
  return (
    <p
      data-person-best-time
      className='mt-1.5 inline-flex flex-wrap items-center gap-x-1.5 text-[12px] text-slate-500 dark:text-slate-400'
      data-tip={`Based on when ${first} made changes over the last 8 weeks`}
    >
      <CalendarClock className='h-3.5 w-3.5 shrink-0' aria-hidden />
      <span>
        Usually online{' '}
        <span className='font-medium text-slate-700 dark:text-slate-200'>{s.hours}</span>
      </span>
      {s.overlap != null && (
        <>
          <span aria-hidden>·</span>
          <span data-person-best-time-overlap>
            {s.overlap === 0 ? 'no overlap with your day' : `overlaps your day ${s.overlap}h`}
          </span>
        </>
      )}
      {s.when && (
        <>
          <span aria-hidden>·</span>
          <span data-person-best-time-when>{s.when}</span>
        </>
      )}
    </p>
  )
}
