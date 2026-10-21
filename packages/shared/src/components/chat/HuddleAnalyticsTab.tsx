import { useQuery } from '@tanstack/react-query'
import { Headphones, RotateCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'

/**
 * Chat analytics → Huddles (#2849): how much huddles are used and how well the calls go.
 * Counts, timings and quality averages only (GET /chat/admin/huddles) — no audio, no
 * content, and direct or group-conversation huddles never name a room or a person.
 */

interface HuddleAnalytics {
  window: { days: number; from: string; to: string; time_zone: string }
  source: 'table' | 'redis'
  live: { huddles: number; people: number }
  totals: {
    huddles: number
    minutes: number
    median_minutes: number | null
    people: number
    screen_share_pct: number | null
    turn_pct: number | null
    ice_failures: number
    ice_failure_sessions: number
    avg_loss_pct: number | null
    avg_rtt_ms: number | null
    quality_reports: number
  }
  per_day: Array<{ day: string; huddles: number; minutes: number }>
  busiest_rooms: Array<{
    room: string
    label: string
    kind: 'channel' | 'general' | 'record'
    huddles: number
    minutes: number
  }>
}

function minutesText(m: number | null): string {
  if (m == null) return '—'
  if (m < 1) return 'under a minute'
  if (m < 60) return `${Math.round(m * 10) / 10} min`
  const h = Math.floor(m / 60)
  const r = Math.round(m % 60)
  return r ? `${h} h ${r} min` : `${h} h`
}

/** "Sep 22" for an axis end (noon, so no time zone moves the date). */
function dayLabel(day: string | undefined): string {
  if (!day) return ''
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <p className='text-[12px] font-medium text-slate-500 dark:text-slate-400'>{label}</p>
      <p className='mt-1 text-[20px] font-semibold tabular-nums text-slate-900 dark:text-slate-50'>
        {value}
      </p>
      {sub && <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>{sub}</p>}
    </div>
  )
}

export function HuddleAnalyticsTab() {
  const client = useNivaroClient()
  const [days, setDays] = useState(30)
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['nvr-huddle-analytics', days],
    queryFn: () =>
      client
        .request<{ data: HuddleAnalytics }>(get('/chat/admin/huddles', { days }))
        .then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: 60_000
  })

  const perDay = data?.per_day ?? []
  const max = useMemo(() => Math.max(1, ...perDay.map((d) => d.huddles)), [perDay])
  const t = data?.totals

  return (
    <div className='space-y-4' data-huddle-analytics>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='inline-flex rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium',
                days === d
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
              )}
            >
              {d} days
            </button>
          ))}
        </div>
        <button
          type='button'
          onClick={() => void refetch()}
          className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted'
        >
          <RotateCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
        {data && (
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1.5 text-[12px]',
              data.live.huddles
                ? 'font-medium text-emerald-700 dark:text-emerald-300'
                : 'text-slate-500 dark:text-slate-400'
            )}
            data-huddle-live-now={data.live.huddles}
          >
            <Headphones className='h-3.5 w-3.5' />
            {data.live.huddles
              ? `${data.live.huddles} live now, ${data.live.people} ${data.live.people === 1 ? 'person' : 'people'}`
              : 'No huddle running right now'}
          </span>
        )}
      </div>

      {isError && (
        <p className='rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300'>
          Huddle figures could not be loaded. Refresh to try again.
        </p>
      )}

      {isLoading && (
        <div className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'>
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className='h-[78px] rounded-lg' />
          ))}
        </div>
      )}

      {data && t && (
        <>
          <div className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'>
            <Figure label='Huddles' value={String(t.huddles)} sub={`${t.people} joins`} />
            <Figure label='Time talking' value={minutesText(t.minutes)} />
            <Figure label='Median length' value={minutesText(t.median_minutes)} />
            <Figure
              label='Through the relay'
              value={t.turn_pct == null ? '—' : `${t.turn_pct}%`}
              sub={t.turn_pct == null ? 'No quality reports yet' : 'of call links used TURN'}
            />
            <Figure
              label='Connection failures'
              value={String(t.ice_failures)}
              sub={
                t.ice_failures
                  ? `in ${t.ice_failure_sessions} ${t.ice_failure_sessions === 1 ? 'huddle' : 'huddles'}`
                  : 'None reported'
              }
            />
            <Figure
              label='Packet loss'
              value={t.avg_loss_pct == null ? '—' : `${t.avg_loss_pct}%`}
              sub={t.avg_rtt_ms == null ? undefined : `${t.avg_rtt_ms} ms round trip`}
            />
          </div>

          {t.huddles === 0 ? (
            <div className='rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center dark:border-border'>
              <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>
                No huddles in the last {days} days
              </p>
              <p className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>
                A huddle is recorded when the last person leaves. Start one from a channel or a
                record&apos;s chat.
              </p>
            </div>
          ) : (
            <div className='grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
              <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
                <h3 className='mb-3 text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                  Huddles per day
                </h3>
                <div
                  className='flex h-[120px] items-end gap-[2px]'
                  role='img'
                  aria-label='Huddles per day'
                >
                  {perDay.map((d) => (
                    <div
                      key={d.day}
                      className='group flex h-full min-w-0 flex-1 items-end'
                      data-tip={`${new Date(`${d.day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${d.huddles} ${d.huddles === 1 ? 'huddle' : 'huddles'}, ${d.minutes} min`}
                    >
                      <div
                        className={cn(
                          'w-full rounded-t-[4px] transition-colors',
                          d.huddles
                            ? 'bg-nvr-cyan group-hover:bg-nvr-navy dark:group-hover:bg-white'
                            : 'bg-transparent'
                        )}
                        style={{ height: d.huddles ? Math.max(3, (d.huddles / max) * 120) : 0 }}
                      />
                    </div>
                  ))}
                </div>
                <div className='mt-1 flex justify-between border-t border-slate-200 pt-1 text-[10.5px] tabular-nums text-slate-500 dark:border-border dark:text-slate-400'>
                  <span>{dayLabel(perDay[0]?.day)}</span>
                  <span>{dayLabel(perDay[perDay.length - 1]?.day)}</span>
                </div>
              </section>

              <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
                <div className='mb-3 flex items-baseline justify-between gap-3'>
                  <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                    Busiest rooms
                  </h3>
                  <p className='text-[11px] text-slate-500 dark:text-slate-400'>
                    Channels and records
                  </p>
                </div>
                {data.busiest_rooms.length === 0 ? (
                  <p className='text-[12px] text-slate-500 dark:text-slate-400'>
                    Only direct huddles so far; those are counted but never named.
                  </p>
                ) : (
                  <table className='w-full table-fixed text-[12.5px] tabular-nums'>
                    <thead>
                      <tr className='text-left text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                        <th className='pb-1 pr-2 font-medium'>Room</th>
                        <th className='w-[64px] pb-1 pr-2 text-right font-medium'>Huddles</th>
                        <th className='w-[84px] pb-1 text-right font-medium'>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.busiest_rooms.map((r) => (
                        <tr key={r.room} className='border-t border-slate-100 dark:border-border'>
                          <td className='py-1.5 pr-2'>
                            <span className='flex min-w-0 items-baseline gap-1.5'>
                              <span
                                className='truncate text-slate-800 dark:text-slate-100'
                                data-tip={r.label}
                              >
                                {r.label}
                              </span>
                              <span className='shrink-0 text-[11px] text-slate-500 dark:text-slate-400'>
                                {r.kind === 'record'
                                  ? 'record'
                                  : r.kind === 'general'
                                    ? 'General'
                                    : 'channel'}
                              </span>
                            </span>
                          </td>
                          <td className='py-1.5 pr-2 text-right text-slate-600 dark:text-slate-300'>
                            {r.huddles}
                          </td>
                          <td className='py-1.5 text-right text-slate-500 dark:text-slate-400'>
                            {minutesText(r.minutes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          )}

          <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
            Quality figures come from the browsers when people leave ({t.quality_reports} report
            {t.quality_reports === 1 ? '' : 's'} in this window). Calls under 15 seconds send none.
            Nothing here records audio, screens or who spoke to whom.
            {data.source === 'redis' &&
              ' Sessions are held temporarily until the database is updated to keep them long term.'}
          </p>
        </>
      )}
    </div>
  )
}
