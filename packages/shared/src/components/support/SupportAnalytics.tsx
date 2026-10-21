import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatNumber } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'

/**
 * Support desk analytics (#1424): GET /support/analytics. Volume by request
 * type and team, first-response and resolution times against their targets,
 * reopen rate, tickets per record collection, how many arrived with a clip or
 * screenshot and who asks most. Counts and timings only. Administrators see
 * every team; a team member sees the tickets routed to their teams.
 */

interface Pctl {
  samples: number
  p50_hours: number | null
  p75_hours: number | null
  target_hours: number
  within_target: number | null
}

interface Analytics {
  window: { days: number; truncated: boolean }
  totals: { tickets: number; open: number; done: number; cancelled: number }
  by_type: Array<{ name: string; tickets: number }>
  by_team: Array<{ name: string; tickets: number }>
  first_response: Pctl
  resolution: Pctl
  reopen: { reopened: number; closed_ever: number; rate: number | null }
  by_collection: Array<{ collection: string; tickets: number }>
  evidence: {
    with_clip: number
    with_screenshot: number
    with_either: number
    share: number | null
  }
  busiest_requesters: Array<{ id: string; name: string | null; tickets: number }>
}

const WINDOWS = [7, 30, 90]

export function formatHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${Number.isInteger(h) ? h : h.toFixed(1)} h`
  return `${(h / 24).toFixed(1)} d`
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)

function Bars({ rows, empty }: { rows: Array<{ label: string; n: number }>; empty: string }) {
  if (!rows.length) return <p className='text-[12px] text-slate-400'>{empty}</p>
  const max = Math.max(...rows.map((r) => r.n), 1)
  return (
    <ul className='space-y-1.5'>
      {rows.map((r) => (
        <li key={r.label} className='flex items-center gap-2 text-[12px]'>
          <span
            className='w-40 shrink-0 truncate text-slate-700 dark:text-slate-200'
            data-tip={r.label}
          >
            {r.label}
          </span>
          <span className='h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10'>
            <span
              className='block h-full rounded-full bg-nvr-cyan'
              style={{ width: `${Math.max(3, (r.n / max) * 100)}%` }}
            />
          </span>
          <span className='w-10 shrink-0 text-right tabular-nums text-slate-500'>
            {formatNumber(r.n)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h3 className='mb-3 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
        {title}
      </h3>
      {children}
    </section>
  )
}

function TimingCell({ label, p, hint }: { label: string; p: Pctl; hint: string }) {
  return (
    <div className='bg-white px-4 py-3 dark:bg-card'>
      <p className='text-[11.5px] text-slate-500'>{label}</p>
      <p className='mt-1 text-[18px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {formatHours(p.p50_hours)}
        <span className='ml-1.5 text-[11.5px] font-normal text-slate-500'>median</span>
      </p>
      <p className='mt-0.5 text-[12px] tabular-nums text-slate-600 dark:text-slate-300'>
        p75 {formatHours(p.p75_hours)} · {pct(p.within_target)} within {formatHours(p.target_hours)}
      </p>
      <p className='mt-0.5 text-[11px] text-slate-400'>
        {p.samples === 0
          ? `No ${hint} yet`
          : `${formatNumber(p.samples)} ticket${p.samples === 1 ? '' : 's'}`}
      </p>
    </div>
  )
}

export function SupportAnalytics({ className }: { className?: string }) {
  const client = useNivaroClient()
  const [days, setDays] = useState(30)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['support-analytics', days],
    queryFn: () =>
      client.request<{ data: Analytics }>(get('/support/analytics', { days })).then((r) => r.data)
  })

  return (
    <div className={cn('mt-4 space-y-4', className)} data-support-analytics>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-[12px] text-slate-500'>
          Tickets raised in the window. Counts and timings only — no ticket text.
        </p>
        <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
          {WINDOWS.map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setDays(d)}
              className={
                days === d
                  ? 'rounded bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium text-slate-800 dark:text-foreground'
                  : 'rounded px-2 py-0.5 text-[11px] font-medium text-slate-500'
              }
            >
              {d}d
            </button>
          ))}
        </span>
      </div>

      {isLoading ? (
        <div className='space-y-3'>
          <Skeleton className='h-24 w-full' />
          <Skeleton className='h-40 w-full' />
        </div>
      ) : isError || !data ? (
        <p className='text-[12.5px] text-red-500'>Analytics could not be loaded.</p>
      ) : data.totals.tickets === 0 ? (
        <p className='py-10 text-center text-[12.5px] text-slate-400'>
          No tickets were raised in the last {days} days.
        </p>
      ) : (
        <>
          <div className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-4 dark:border-border dark:bg-border'>
            <div className='bg-white px-4 py-3 dark:bg-card'>
              <p className='text-[11.5px] text-slate-500'>Tickets</p>
              <p className='mt-1 text-[18px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                {formatNumber(data.totals.tickets)}
              </p>
              <p className='mt-0.5 text-[12px] tabular-nums text-slate-600 dark:text-slate-300'>
                {data.totals.open} open · {data.totals.done} done · {data.totals.cancelled}{' '}
                cancelled
              </p>
            </div>
            <TimingCell label='First response' p={data.first_response} hint='replies' />
            <TimingCell label='Resolution' p={data.resolution} hint='resolved tickets' />
            <div className='bg-white px-4 py-3 dark:bg-card'>
              <p className='text-[11.5px] text-slate-500'>Reopened</p>
              <p className='mt-1 text-[18px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                {pct(data.reopen.rate)}
              </p>
              <p className='mt-0.5 text-[12px] tabular-nums text-slate-600 dark:text-slate-300'>
                {data.reopen.reopened} of {data.reopen.closed_ever} closed tickets
              </p>
            </div>
          </div>

          <div className='grid gap-4 lg:grid-cols-2'>
            <Block title='By request type'>
              <Bars
                rows={data.by_type.map((r) => ({ label: r.name, n: r.tickets }))}
                empty='No tickets.'
              />
            </Block>
            <Block title='By team'>
              <Bars
                rows={data.by_team.map((r) => ({ label: r.name, n: r.tickets }))}
                empty='No tickets.'
              />
            </Block>
            <Block title='Tickets per kind of record'>
              <Bars
                rows={data.by_collection.map((r) => ({ label: r.collection, n: r.tickets }))}
                empty='No tickets.'
              />
            </Block>
            <Block title='Busiest requesters'>
              <Bars
                rows={data.busiest_requesters.map((r) => ({
                  label: r.name ?? r.id.slice(0, 8),
                  n: r.tickets
                }))}
                empty='No requesters.'
              />
            </Block>
          </div>

          <Block title='Tickets with a clip or screenshot'>
            <p className='text-[12.5px] text-slate-700 dark:text-slate-200'>
              <span className='font-semibold tabular-nums'>{pct(data.evidence.share)}</span> of
              tickets carried one ({data.evidence.with_clip} with a replay clip,{' '}
              {data.evidence.with_screenshot} with a screenshot or file).
            </p>
          </Block>
          {data.window.truncated && (
            <p className='text-[11.5px] text-slate-400'>
              The window holds more tickets than are counted; narrow it for exact figures.
            </p>
          )}
        </>
      )}
    </div>
  )
}
