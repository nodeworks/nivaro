import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Gauge, Loader2, PlayCircle } from 'lucide-react'
import { useState } from 'react'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { replayHref } from '../../lib/replay-capture'
import { cn } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { SectionCard } from './primitives'

/**
 * One person's slowest screens (GET /api/slow-screens/:userId, administrators only): per
 * page how often they opened it, median and p95 time, the browsers and screen sizes they
 * used, the slowest calls behind it and a replay of a slow visit when one was recorded.
 * Shown on the people page (Activity → Slow screens) and on support tickets about slowness.
 */

interface CallStat {
  method: string
  path: string
  n: number
  visits: number
  median_ms: number
  worst_ms: number
  errors: number
}
interface PageStat {
  app: string
  page: string
  n: number
  loads: number
  moves: number
  median_ms: number
  p95_ms: number
  worst_ms: number
  visits: number
  devices: Array<{
    browser: string | null
    os: string | null
    screen: string | null
    n: number
    median_ms: number
  }>
  slow_visits: Array<{
    at: number
    ms: number
    kind: 'load' | 'route'
    browser: string | null
    screen: string | null
    replay: { recording_id: string; offset_ms: number } | null
  }>
  calls: CallStat[]
  calls_from_visits: number
}
export interface SlowScreensData {
  user_id: string
  days: number
  timing_days: number
  samples: number
  pages: PageStat[]
  devices: {
    browsers: Array<{ name: string; n: number }>
    screens: Array<{ name: string; n: number }>
  }
  journeys: boolean
  no_timings: boolean
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 1000)} s`
}

/** Under a second reads fine, up to three is slow, past that a person notices. */
function tone(ms: number): string {
  if (ms < 1000) return 'text-emerald-700 dark:text-emerald-400'
  if (ms < 3000) return 'text-amber-700 dark:text-amber-400'
  return 'text-red-700 dark:text-red-400'
}

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

export function SlowScreensCard({
  userId,
  name,
  compact = false,
  className
}: {
  userId: string
  /** First name, for the empty-state sentence. */
  name?: string | null
  /** Ticket view: five pages, no device line. */
  compact?: boolean
  className?: string
}) {
  const client = useNivaroClient()
  const [days, setDays] = useState<7 | 30>(7)
  const q = useQuery({
    queryKey: ['nvr-slow-screens', userId, days],
    queryFn: () =>
      client
        .request<{ data: SlowScreensData }>(
          get(`/slow-screens/${encodeURIComponent(userId)}`, { days })
        )
        .then((r) => r.data),
    staleTime: 60_000,
    retry: false
  })
  const who = name || 'This person'
  const pages = compact ? (q.data?.pages ?? []).slice(0, 5) : (q.data?.pages ?? [])

  return (
    <SectionCard
      icon={<Gauge className='h-4 w-4' />}
      title='Slow screens'
      hint='Their own page timings, slowest first'
      testId='slow-screens'
      className={className}
      actions={
        <fieldset
          className='inline-flex gap-0.5 rounded-md border border-slate-200 p-0.5 dark:border-border'
          data-slow-screens-days={days}
        >
          <legend className='sr-only'>Period</legend>
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              type='button'
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={cn(
                'h-6 rounded px-2 text-[11px] font-medium',
                days === d
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
              )}
            >
              {d} days
            </button>
          ))}
        </fieldset>
      }
    >
      {q.isLoading ? (
        <p className='flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' /> Reading their page timings…
        </p>
      ) : q.isError ? (
        <ErrorNotice error={q.error} what='their page timings' onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.no_timings ? (
        <p className='text-[12.5px] text-slate-500 dark:text-slate-400' data-slow-screens-empty>
          {who} has no page timings in the last {Math.min(days, 14)} days. Timings come from their
          browser while they use the app, and are kept 14 days.
        </p>
      ) : (
        <div className='space-y-3' data-slow-screens={q.data.pages.length}>
          {!compact && <DeviceLine data={q.data} />}
          <div className='overflow-x-auto'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-left text-[11px] text-slate-500 dark:border-border dark:text-slate-400'>
                  <th className='py-1.5 pr-2 font-medium'>Page</th>
                  <th className='w-[1%] whitespace-nowrap px-2 py-1.5 text-right font-medium'>
                    Times
                  </th>
                  <th className='w-[1%] whitespace-nowrap px-2 py-1.5 text-right font-medium'>
                    Median
                  </th>
                  <th className='w-[1%] whitespace-nowrap px-2 py-1.5 text-right font-medium'>
                    p95
                  </th>
                  <th className='w-[1%] whitespace-nowrap py-1.5 pl-2 text-right font-medium'>
                    Worst
                  </th>
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => (
                  <PageRow key={`${p.app} ${p.page}`} page={p} />
                ))}
              </tbody>
            </table>
          </div>
          <p className='text-[11px] leading-relaxed text-slate-500 dark:text-slate-400'>
            {q.data.samples.toLocaleString()} timings from their browser
            {days > q.data.timing_days
              ? ` over the last ${q.data.timing_days} days (timings and requests are kept ${q.data.timing_days} days)`
              : ` over the last ${days} days`}
            . A full load counts until its largest paint; a move inside the app until the new page
            settles.
            {!q.data.journeys && ' No page visits were recorded, so calls cannot be tied to pages.'}
          </p>
        </div>
      )}
    </SectionCard>
  )
}

function DeviceLine({ data }: { data: SlowScreensData }) {
  const { browsers, screens } = data.devices
  if (browsers.length === 0 && screens.length === 0) return null
  const total = data.samples || 1
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`
  return (
    <dl className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2 dark:border-border dark:bg-border'>
      <div className='bg-white px-3 py-2 dark:bg-card'>
        <dt className='text-[10.5px] uppercase tracking-wide text-slate-500 dark:text-slate-400'>
          Browser
        </dt>
        <dd className='mt-0.5 text-[12px] text-slate-800 dark:text-slate-100'>
          {browsers.map((b) => `${b.name} ${pct(b.n)}`).join(' · ') || 'Not reported'}
        </dd>
      </div>
      <div className='bg-white px-3 py-2 dark:bg-card'>
        <dt className='text-[10.5px] uppercase tracking-wide text-slate-500 dark:text-slate-400'>
          Screen size
        </dt>
        <dd className='mt-0.5 text-[12px] text-slate-800 dark:text-slate-100'>
          {screens.map((s) => `${s.name} ${pct(s.n)}`).join(' · ') || 'Not reported'}
        </dd>
      </div>
    </dl>
  )
}

function PageRow({ page: p }: { page: PageStat }) {
  const [open, setOpen] = useState(false)
  const nav = useNavigation()
  return (
    <>
      <tr
        className='border-b border-slate-100 last:border-0 dark:border-border/60'
        data-slow-screen={p.page}
      >
        <td className='max-w-0 py-1.5 pr-2'>
          <button
            type='button'
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className='flex w-full min-w-0 items-center gap-1 text-left'
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
                open && 'rotate-90'
              )}
            />
            <span className='truncate font-mono text-[11.5px] text-slate-800 dark:text-slate-100'>
              {p.page}
            </span>
            {p.app !== 'admin' && (
              <span className='shrink-0 rounded bg-slate-100 px-1 text-[10px] text-slate-500 dark:bg-white/10 dark:text-slate-400'>
                {p.app}
              </span>
            )}
          </button>
        </td>
        <td className='whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300'>
          {p.n}
        </td>
        <td
          className={cn('whitespace-nowrap px-2 py-1.5 text-right tabular-nums', tone(p.median_ms))}
        >
          {formatMs(p.median_ms)}
        </td>
        <td
          className={cn(
            'whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums',
            tone(p.p95_ms)
          )}
        >
          {formatMs(p.p95_ms)}
        </td>
        <td className='whitespace-nowrap py-1.5 pl-2 text-right tabular-nums text-slate-500 dark:text-slate-400'>
          {formatMs(p.worst_ms)}
        </td>
      </tr>
      {open && (
        <tr className='border-b border-slate-100 dark:border-border/60'>
          <td colSpan={5} className='bg-slate-50 px-3 py-3 dark:bg-white/[0.03]'>
            <div className='grid gap-4 lg:grid-cols-2'>
              <div>
                <h4 className='mb-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                  Slowest calls while it loaded
                </h4>
                {p.calls.length === 0 ? (
                  <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
                    {p.calls_from_visits === 0
                      ? 'No recorded visits to tie calls to.'
                      : 'No calls in the first seconds of their recent visits.'}
                  </p>
                ) : (
                  <ul className='space-y-1'>
                    {p.calls.map((c) => (
                      <li
                        key={`${c.method} ${c.path}`}
                        className='flex items-baseline gap-2 text-[11.5px]'
                      >
                        <span className='min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-slate-200'>
                          <span className='text-slate-400'>{c.method}</span> {c.path}
                        </span>
                        <span className={cn('shrink-0 tabular-nums', tone(c.median_ms))}>
                          {formatMs(c.median_ms)}
                        </span>
                        <span className='w-[92px] shrink-0 text-right text-[10.5px] text-slate-500 dark:text-slate-400'>
                          worst {formatMs(c.worst_ms)}
                          {c.errors > 0 && (
                            <span className='ml-1 text-red-600 dark:text-red-400'>
                              · {c.errors} failed
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                    <li className='pt-0.5 text-[10.5px] text-slate-500 dark:text-slate-400'>
                      From their {p.calls_from_visits} most recent visits.
                    </li>
                  </ul>
                )}
              </div>
              <div className='space-y-3'>
                <div>
                  <h4 className='mb-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                    Slowest visits
                  </h4>
                  <ul className='space-y-1'>
                    {p.slow_visits.map((v) => {
                      const path = v.replay ? replayHref(v.replay) : null
                      const href = path ? (nav.consoleUrl ? nav.consoleUrl(path) : path) : null
                      return (
                        <li
                          key={`${v.at}-${v.ms}`}
                          className='flex items-center gap-2 text-[11.5px]'
                        >
                          <span className={cn('w-14 shrink-0 tabular-nums', tone(v.ms))}>
                            {formatMs(v.ms)}
                          </span>
                          <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                            {when(v.at)} · {v.kind === 'load' ? 'full load' : 'in-app move'}
                            {v.browser ? ` · ${v.browser}` : ''}
                            {v.screen ? ` · ${v.screen}` : ''}
                          </span>
                          {href ? (
                            <a
                              href={href}
                              target='_blank'
                              rel='noreferrer'
                              data-slow-screen-replay={v.replay?.recording_id}
                              className='inline-flex shrink-0 items-center gap-1 font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
                            >
                              <PlayCircle className='h-3.5 w-3.5' /> Replay
                            </a>
                          ) : (
                            <span className='shrink-0 text-[10.5px] text-slate-400'>
                              not recorded
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
                {p.devices.length > 1 && (
                  <div>
                    <h4 className='mb-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                      By browser and screen
                    </h4>
                    <ul className='space-y-0.5'>
                      {p.devices.map((d) => (
                        <li
                          key={`${d.browser}|${d.os}|${d.screen}`}
                          className='flex gap-2 text-[11.5px] text-slate-600 dark:text-slate-300'
                        >
                          <span className='min-w-0 flex-1 truncate'>
                            {[d.browser, d.os, d.screen].filter(Boolean).join(' · ') ||
                              'Not reported'}
                          </span>
                          <span className='shrink-0 tabular-nums text-slate-500'>{d.n}×</span>
                          <span
                            className={cn(
                              'w-14 shrink-0 text-right tabular-nums',
                              tone(d.median_ms)
                            )}
                          >
                            {formatMs(d.median_ms)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** Words that make a support ticket about slowness (the ticket opens the card for them). */
export function looksLikeSlowness(text: string | null | undefined): boolean {
  return /\b(slow|slowly|sluggish|lag+y?|lagging|loading|takes? (forever|ages|long)|spinning|spinner|freez(e|es|ing)|frozen|hang(s|ing)?|time[sd]? ?out|timeout|unresponsive|performance)\b/i.test(
    String(text ?? '')
  )
}
