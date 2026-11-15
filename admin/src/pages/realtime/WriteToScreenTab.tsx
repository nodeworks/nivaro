import { queryKeys } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

/**
 * Write to screen (realtime round 5, item 25): from the moment someone saves a change to the
 * moment another person's open screen shows it. A small sample of changes is timed by the
 * screens that show them (the delivery acknowledgement sample, #2477); the server keeps hourly
 * histograms only (GET /realtime/write-to-screen).
 */

interface Figures {
  samples: number
  p50_ms: number | null
  p95_ms: number | null
}

interface Report {
  window_hours: number
  overall: Figures
  delivery: Figures
  render: Figures
  hours: Array<Figures & { hour: string }>
  screens: Array<Figures & { app: string; screen: string; collection: string }>
}

/** Above this a change feels late (the delivery SLO's own target). */
const SLOW_MS = 2000

export function seconds(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${(ms / 1000).toFixed(1)} s`
}

/** Below this many hours with timed changes the hourly chart says too little to draw. */
const MIN_CHART_HOURS = 3

const SCREEN_NAMES: Array<[RegExp, string]> = [
  [/^\/$/, 'Home'],
  [/^\/(?:admin\/)?(?:collections|records)\/[^/]+\/(?::id|new)$/, 'Record page'],
  [/^\/(?:admin\/)?(?:collections|records)\/[^/]+$/, 'List'],
  [/^\/(?:admin\/)?queues\/:id$/, 'Queue'],
  [/^\/(?:admin\/)?queues$/, 'Queues'],
  [/^\/(?:admin\/)?dashboards?\/:id$/, 'Dashboard'],
  [/^\/my-work/, 'My Work'],
  [/^\/search/, 'Search'],
  [/^\/command/, 'Command Center']
]

/** A screen pattern ("/collections/:c/:id") in plain words ("Record page"). */
export function screenName(pattern: string): string {
  for (const [re, name] of SCREEN_NAMES) if (re.test(pattern)) return name
  const parts = pattern.split('/').filter((p) => p && !p.startsWith(':'))
  return parts.length ? titleCase(parts.join(' › ').replace(/[-_]/g, ' ')) : 'Home'
}

const WINDOWS: Array<[number, string]> = [
  [24, 'Last 24 hours'],
  [168, 'Last 7 days']
]

export function WriteToScreenTab() {
  const [hours, setHours] = useState(24)
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['realtime-write-to-screen', hours],
    queryFn: () =>
      api
        .get<{ data: Report }>('/realtime/write-to-screen', { params: { hours } })
        .then((r) => r.data.data),
    refetchInterval: 60_000
  })

  const { data: collections } = useQuery<
    Array<{ collection: string; display_name?: string | null; plural?: string | null }>
  >({
    queryKey: queryKeys.collections(),
    queryFn: () => api.get('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })
  const labelOf = useMemo(() => {
    const map = new Map(
      (collections ?? []).map((c) => [c.collection, c.display_name || c.plural || null])
    )
    return (name: string) => map.get(name) || titleCase(name.replace(/_/g, ' '))
  }, [collections])

  const points = useMemo(
    () =>
      (data?.hours ?? []).map((h) => {
        const d = new Date(h.hour)
        return {
          label:
            hours > 48
              ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
              : d.toLocaleTimeString(undefined, { hour: 'numeric' }),
          p50: h.p50_ms != null ? h.p50_ms / 1000 : null,
          p95: h.p95_ms != null ? h.p95_ms / 1000 : null,
          samples: h.samples
        }
      }),
    [data, hours]
  )

  const hoursWithData = (data?.hours ?? []).filter((h) => h.samples > 0).length

  return (
    <div className='space-y-6' data-write-to-screen={data ? 'ready' : 'loading'}>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='max-w-3xl text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
          <p>
            How long a change someone saves takes to show on other people's open screens: from the
            save to the moment their page has re-drawn it.
          </p>
          <details className='group mt-1'>
            <summary className='cursor-pointer select-none font-medium text-slate-600 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:text-foreground'>
              How this is measured
            </summary>
            <p className='mt-1'>
              Screens time a small sample of changes: about 1 in 50, and at least one every 30
              seconds per server. Tabs set to Calm or Off live updates, hidden tabs and the tab that
              made the save are not timed. Amber marks a p95 over the {seconds(SLOW_MS)} target.
            </p>
          </details>
        </div>
        <fieldset
          aria-label='Window'
          className='m-0 inline-flex h-8 min-w-0 items-center rounded-md border border-slate-200 p-0.5 dark:border-border'
        >
          {WINDOWS.map(([h, label]) => (
            <button
              key={h}
              type='button'
              aria-pressed={hours === h}
              onClick={() => setHours(h)}
              className={cn(
                'h-full rounded px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                hours === h
                  ? 'bg-[#00ceff]/10 text-[#0e7490] dark:text-[#67e8f9]'
                  : 'text-slate-600 hover:bg-muted dark:text-muted-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>

      {isLoading ? (
        <div className='space-y-3'>
          <Skeleton className='h-20 w-full' />
          <Skeleton className='h-56 w-full' />
        </div>
      ) : isError || !data ? (
        <div className='rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          The timings did not load.{' '}
          <button
            type='button'
            onClick={() => void refetch()}
            className='font-medium text-[#0e7490] hover:underline dark:text-[#67e8f9]'
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
            <Cell
              label='On other screens (p95)'
              value={seconds(data.overall.p95_ms)}
              note={
                data.overall.p95_ms != null && data.overall.p95_ms > SLOW_MS
                  ? `over the ${seconds(SLOW_MS)} target · median ${seconds(data.overall.p50_ms)}`
                  : `median ${seconds(data.overall.p50_ms)}`
              }
              tone={
                data.overall.p95_ms != null && data.overall.p95_ms > SLOW_MS
                  ? 'text-amber-700 dark:text-amber-300'
                  : undefined
              }
            />
            <Cell
              label='Reaching the tab (p95)'
              value={seconds(data.delivery.p95_ms)}
              note='save → event arrives'
            />
            <Cell
              label='Re-drawing (p95)'
              value={seconds(data.render.p95_ms)}
              note='event → page shows it'
            />
            <Cell
              label='Timed changes'
              value={data.overall.samples.toLocaleString()}
              note={hours > 24 ? 'last 7 days' : 'last 24 hours'}
            />
          </div>

          <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <h2 className='mb-3 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              By hour
            </h2>
            {data.overall.samples === 0 ? (
              <p className='py-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                No timed changes yet. They arrive as people's open screens show others' saves.
              </p>
            ) : hoursWithData < MIN_CHART_HOURS ? (
              <p
                className='py-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'
                data-chart='sparse'
              >
                {data.overall.samples.toLocaleString()} timed{' '}
                {data.overall.samples === 1 ? 'change' : 'changes'} so far, too few to chart by
                hour. The chart appears once changes are timed in {MIN_CHART_HOURS} different hours.
              </p>
            ) : (
              <div className='text-slate-500 dark:text-muted-foreground'>
                <ResponsiveContainer width='100%' height={220}>
                  <LineChart data={points} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke='currentColor' strokeOpacity={0.1} />
                    <XAxis
                      dataKey='label'
                      tick={{ fontSize: 10, fill: 'currentColor' }}
                      tickLine={false}
                      axisLine={{ stroke: 'currentColor', strokeOpacity: 0.2 }}
                      interval={hours > 48 ? 23 : 1}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'currentColor' }}
                      tickLine={false}
                      axisLine={false}
                      unit=' s'
                      width={48}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 12,
                        backgroundColor: '#0f172a',
                        border: '1px solid #334155',
                        borderRadius: 8,
                        color: '#f1f5f9'
                      }}
                      labelStyle={{ color: '#f1f5f9' }}
                      itemStyle={{ color: '#e2e8f0' }}
                      formatter={(value, name) => [
                        value == null ? '—' : `${Number(value).toFixed(2)} s`,
                        name === 'p95' ? 'p95' : 'Median'
                      ]}
                    />
                    <Line
                      type='monotone'
                      dataKey='p95'
                      stroke='#00b8e0'
                      strokeWidth={2}
                      // An hour on its own (no neighbours) draws no line: the dot shows it.
                      dot={{ r: 2.5, strokeWidth: 0, fill: '#00b8e0' }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type='monotone'
                      dataKey='p50'
                      stroke='currentColor'
                      strokeOpacity={0.55}
                      strokeWidth={1.5}
                      strokeDasharray='4 3'
                      dot={{ r: 2, strokeWidth: 0, fill: 'currentColor', fillOpacity: 0.55 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
                <div className='mt-2 flex gap-4 text-[11px]'>
                  <span className='inline-flex items-center gap-1.5'>
                    <span aria-hidden className='h-0.5 w-4 rounded bg-[#00b8e0]' />
                    p95
                  </span>
                  <span className='inline-flex items-center gap-1.5'>
                    <span
                      aria-hidden
                      className='h-0 w-4 border-t-[1.5px] border-dashed border-current opacity-60'
                    />
                    Median
                  </span>
                </div>
              </div>
            )}
          </section>

          <section>
            <h2 className='mb-2 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              By screen and collection
            </h2>
            {data.screens.length === 0 ? (
              <p className='rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                Nothing timed in this window.
              </p>
            ) : (
              <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
                <table className='w-full text-[12px] tabular-nums'>
                  <thead>
                    <tr className='border-b border-slate-200 bg-slate-50 text-left text-[11px] font-semibold text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
                      <th className='px-3 py-2'>Screen</th>
                      <th className='px-3 py-2'>Collection</th>
                      <th className='px-3 py-2'>App</th>
                      <th className='px-3 py-2 text-right'>Timed</th>
                      <th className='px-3 py-2 text-right'>Median</th>
                      <th className='px-3 py-2 text-right'>
                        <span data-tip={`Amber: over the ${seconds(SLOW_MS)} target`}>p95</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className='divide-y divide-slate-100 bg-white dark:divide-border/60 dark:bg-card'>
                    {data.screens.map((s) => (
                      <tr key={`${s.app}|${s.screen}|${s.collection}`}>
                        <td className='px-3 py-1.5 text-slate-800 dark:text-foreground'>
                          <span data-tip={s.screen}>{screenName(s.screen)}</span>
                        </td>
                        <td className='px-3 py-1.5'>
                          <span className='text-slate-800 dark:text-foreground'>
                            {labelOf(s.collection)}
                          </span>
                          <span className='ml-2 font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
                            {s.collection}
                          </span>
                        </td>
                        <td className='px-3 py-1.5 text-slate-500 dark:text-muted-foreground'>
                          {titleCase(s.app)}
                        </td>
                        <td className='px-3 py-1.5 text-right text-slate-600 dark:text-muted-foreground'>
                          {s.samples.toLocaleString()}
                        </td>
                        <td className='px-3 py-1.5 text-right text-slate-600 dark:text-muted-foreground'>
                          {seconds(s.p50_ms)}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-1.5 text-right font-medium',
                            s.p95_ms != null && s.p95_ms > SLOW_MS
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-slate-800 dark:text-foreground'
                          )}
                        >
                          {seconds(s.p95_ms)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.screens.some((x) => x.p95_ms != null && x.p95_ms > SLOW_MS) && (
              <p className='mt-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                <span className='font-medium text-amber-700 dark:text-amber-300'>Amber</span>: p95
                over the {seconds(SLOW_MS)} target.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Cell({
  label,
  value,
  note,
  tone
}: {
  label: string
  value: string
  note?: string
  tone?: string
}) {
  return (
    <div className='bg-white px-4 py-3 dark:bg-card'>
      <p className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[18px] font-semibold tabular-nums text-slate-900 dark:text-foreground',
          tone
        )}
      >
        {value}
      </p>
      {note ? (
        <p className='mt-0.5 truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
          {note}
        </p>
      ) : null}
    </div>
  )
}
