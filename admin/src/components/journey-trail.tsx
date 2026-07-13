import { useQuery } from '@tanstack/react-query'
import { Footprints } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Journey trail — a user's path through the admin, one timeline per session.
 * Data comes from the persisted page-presence pings (30-day retention).
 * Admin-only (the API refuses otherwise).
 */

interface JourneyStep {
  path: string
  entered_at: string
  duration_seconds: number | null
}

interface JourneySession {
  session_id: string
  started_at: string
  steps: JourneyStep[]
}

function pageLabel(path: string): string {
  if (path === '/') return 'Dashboard'
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'collections' && parts[1]) {
    return parts[2] ? `${parts[1]} · record ${parts[2]}` : `${parts[1]} (browser)`
  }
  return parts
    .map((p) => p.replace(/-/g, ' '))
    .join(' › ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return ''
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function JourneyTrail({ userId }: { userId: string }) {
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)

  const { data: days = [] } = useQuery({
    queryKey: ['journey-days', userId],
    queryFn: () =>
      api
        .get<{ data: Array<{ date: string; steps: number }> }>(`/journeys/days/${userId}`)
        .then((r) => r.data.data)
  })

  const { data, isLoading } = useQuery({
    queryKey: ['journey', userId, date],
    queryFn: () =>
      api
        .get<{ data: { sessions: JourneySession[] } }>(`/journeys/user/${userId}`, {
          params: { date }
        })
        .then((r) => r.data.data)
  })
  const sessions = data?.sessions ?? []

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'>
      <div className='mb-1 flex items-center justify-between'>
        <h2 className='flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
          <Footprints className='h-3.5 w-3.5' /> Journey Trail
        </h2>
      </div>
      <p className='mb-3 text-[12px] text-slate-400'>
        Every page this user visited, session by session. Kept for 30 days.
      </p>

      {days.length > 0 && (
        <div className='mb-4 flex flex-wrap gap-1.5'>
          {days.slice(0, 14).map((d) => (
            <button
              key={d.date}
              type='button'
              onClick={() => setDate(d.date)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px]',
                date === d.date
                  ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-400 dark:border-border'
              )}
              title={`${d.steps} page views`}
            >
              {d.date === today ? 'Today' : d.date.slice(5)}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <p className='py-6 text-center text-[12px] text-slate-400'>Loading…</p>
      ) : sessions.length === 0 ? (
        <p className='py-6 text-center text-[12px] text-slate-400'>
          No admin activity recorded on {date === today ? 'today' : date}.
        </p>
      ) : (
        <div className='space-y-4'>
          {sessions.map((s, si) => (
            <div key={s.session_id}>
              <p className='mb-1.5 text-[11px] font-medium text-slate-400'>
                Session {si + 1} · started {formatRelative(s.started_at)} · {s.steps.length} page
                {s.steps.length === 1 ? '' : 's'}
              </p>
              <ol className='relative ml-2 space-y-0 border-l border-slate-200 dark:border-border'>
                {s.steps.map((step, i) => (
                  <li key={`${step.entered_at}-${i}`} className='relative py-1 pl-4'>
                    <span className='absolute -left-[3.5px] top-[13px] h-1.5 w-1.5 rounded-full bg-[#00ceff]' />
                    <div className='flex items-baseline gap-2'>
                      <Link
                        to={step.path}
                        className='truncate text-[12.5px] text-slate-700 hover:text-nvr-navy hover:underline dark:text-slate-300 dark:hover:text-nvr-cyan'
                      >
                        {pageLabel(step.path)}
                      </Link>
                      <span className='shrink-0 text-[10.5px] tabular-nums text-slate-400'>
                        {new Date(step.entered_at).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                        {step.duration_seconds != null &&
                          ` · ${fmtDuration(step.duration_seconds)}`}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
