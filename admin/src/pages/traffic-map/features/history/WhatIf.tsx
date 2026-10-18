/**
 * #2151 — what-if capacity, beside the headroom gauge: try "+50% traffic", "add a replica" or
 * "move the nightly import to 02:00" and see the projected headroom, pool pressure and event-loop
 * lag, from today's cost per request (GET /traffic-map/capacity/what-if — a projection, nothing
 * changes). Anchored popover beside the button.
 */
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PopoverContent } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { fmtRate } from '../../EventTicker'
import { fmtLag, LINK } from '../ops-common'
import { errorOf, Note } from '../shared'
import type { JobsBody, WhatIfBody, WhatIfFigures } from './shared'
import { fmtUtcMinute } from './shared'

const TRAFFIC = [-30, 0, 25, 50, 100, 200]
const REPLICAS = [-1, 0, 1, 2]

function Chip({
  on,
  onClick,
  children,
  id
}: {
  on: boolean
  onClick: () => void
  children: string
  id?: string
}) {
  return (
    <button
      type='button'
      id={id}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-md border px-1.5 py-[1px] text-[11.5px] tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        on
          ? 'border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
          : 'border-[var(--tm-line)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      {children}
    </button>
  )
}

/** Pool use as a share of the pool when its size is known, else connections. */
function poolText(f: WhatIfFigures): string {
  return f.pool_pct != null ? `${f.pool_pct}%` : `${f.pool_used} connections`
}

function Cell({ f, field }: { f: WhatIfFigures; field: 'rps' | 'headroom' | 'pool' | 'loop' }) {
  const v =
    field === 'rps'
      ? `${fmtRate(f.rps_per_replica)} req/s`
      : field === 'headroom'
        ? f.headroom_pct != null
          ? `${f.headroom_pct}%`
          : '—'
        : field === 'pool'
          ? poolText(f)
          : f.loop_p99_ms == null
            ? '—'
            : fmtLag(f.loop_p99_ms)
  const bad =
    (field === 'headroom' && (f.headroom_pct ?? 0) >= 90) ||
    (field === 'pool' && (f.pool_pct ?? 0) >= 90)
  return (
    <td
      className={cn(
        'py-0.5 pl-2 text-right tabular-nums',
        bad && 'font-medium text-[var(--tm-error-ink)]'
      )}
    >
      {v}
    </td>
  )
}

function WhatIfBodyView() {
  const [pct, setPct] = useState(50)
  const [add, setAdd] = useState(0)
  const [job, setJob] = useState('')
  const [toHour, setToHour] = useState('2')
  const jobs = useQuery({
    queryKey: ['traffic-map', 'history', 'jobs'],
    queryFn: async () =>
      ((await api.get('/traffic-map/history/jobs'))?.data?.data ?? null) as JobsBody | null,
    staleTime: 10 * 60_000
  })
  // The hour is picked in the viewer's clock; the server wants the UTC minute of the day.
  const offsetMin = -new Date().getTimezoneOffset()
  const toMinute = (((Number(toHour) * 60 - offsetMin) % 1440) + 1440) % 1440
  const q = useQuery({
    queryKey: ['traffic-map', 'ops', 'what-if', pct, add, job, job ? toMinute : null],
    queryFn: async () =>
      ((
        await api.get('/traffic-map/capacity/what-if', {
          params: {
            traffic_pct: pct,
            add_replicas: add,
            ...(job ? { job, to_minute: toMinute } : {})
          }
        })
      )?.data?.data ?? null) as WhatIfBody | null,
    staleTime: 10_000
  })
  const r = q.data
  const movable = (jobs.data?.jobs ?? []).filter((j) => j.start_minute_utc != null)
  return (
    <div className='grid gap-2 text-[12px]' data-tm-what-if=''>
      <div className='grid gap-1'>
        <span className='text-[11.5px] text-[var(--tm-muted)]'>Traffic</span>
        <div className='flex flex-wrap gap-1'>
          {TRAFFIC.map((p) => (
            <Chip key={p} on={pct === p} onClick={() => setPct(p)} id={`tm-what-if-traffic-${p}`}>
              {p === 0 ? 'as now' : `${p > 0 ? '+' : ''}${p}%`}
            </Chip>
          ))}
        </div>
      </div>
      <div className='grid gap-1'>
        <span className='text-[11.5px] text-[var(--tm-muted)]'>
          Replicas{r ? ` (now ${r.replicas.now})` : ''}
        </span>
        <div className='flex flex-wrap gap-1'>
          {REPLICAS.map((n) => (
            <Chip key={n} on={add === n} onClick={() => setAdd(n)} id={`tm-what-if-replicas-${n}`}>
              {n === 0 ? 'as now' : `${n > 0 ? '+' : ''}${n}`}
            </Chip>
          ))}
        </div>
      </div>
      <div className='grid gap-1'>
        <span className='text-[11.5px] text-[var(--tm-muted)]'>Move a scheduled job</span>
        <div className='flex flex-wrap items-center gap-1.5'>
          <SimpleSelect
            value={job || '__none__'}
            onChange={(v) => setJob(v === '__none__' ? '' : v)}
            options={[
              { value: '__none__', label: 'No job' },
              ...movable.map((j) => ({
                value: j.id,
                label: `${j.id} (${fmtUtcMinute(j.start_minute_utc as number)})`
              }))
            ]}
            ariaLabel='Job to move'
            triggerProps={{ id: 'tm-what-if-job' }}
            className='h-7 w-auto min-w-[140px] max-w-[200px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
          />
          {job && (
            <>
              <span className='text-[var(--tm-muted)]'>to</span>
              <SimpleSelect
                value={toHour}
                onChange={setToHour}
                options={Array.from({ length: 24 }, (_, h) => ({
                  value: String(h),
                  label: `${String(h).padStart(2, '0')}:00`
                }))}
                ariaLabel='New start (your time)'
                triggerProps={{ id: 'tm-what-if-hour' }}
                className='h-7 w-auto min-w-[76px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
              />
            </>
          )}
        </div>
      </div>
      {q.isError ? (
        <Note tone='error'>{errorOf(q.error)}</Note>
      ) : !r ? (
        <div
          className='h-[88px] animate-pulse rounded-md bg-[var(--tm-skeleton)]'
          role='status'
          aria-label='Loading'
        />
      ) : (
        <>
          <table className='w-full' data-tm-what-if-table=''>
            <thead>
              <tr className='text-[11px] text-[var(--tm-muted)]'>
                <th className='py-0.5 text-left font-medium'>Per replica</th>
                <th className='py-0.5 pl-2 text-right font-medium'>Now</th>
                <th className='py-0.5 pl-2 text-right font-medium'>Projected</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['rps', 'Requests'],
                  ['headroom', 'Of capacity'],
                  ['pool', 'Pool in use'],
                  ['loop', 'Event-loop p99']
                ] as const
              ).map(([field, label]) => (
                <tr key={field} className='border-t border-[var(--tm-line-2)]'>
                  <td className='py-0.5 text-[var(--tm-fg-2)]'>{label}</td>
                  <Cell f={r.now} field={field} />
                  <Cell f={r.projected} field={field} />
                </tr>
              ))}
            </tbody>
          </table>
          {r.job && (
            <p className='text-[11.5px] text-[var(--tm-fg-2)]' data-tm-what-if-job=''>
              Moving <span className='font-mono'>{r.job.id}</span>: pool at its slot now{' '}
              {poolText(r.job.from_before)} → {poolText(r.job.from_after)} without it; at{' '}
              {String(toHour).padStart(2, '0')}:00 {poolText(r.job.to_before)} →{' '}
              {poolText(r.job.to_after)}.
            </p>
          )}
          {r.notes.map((n) => (
            <Note key={n}>{n}</Note>
          ))}
          <p className='text-[11px] text-[var(--tm-muted)]'>
            From today&apos;s cost per request; a rough guide, not a load test.
          </p>
        </>
      )}
    </div>
  )
}

export function WhatIfButton() {
  const [open, setOpen] = useState(false)
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button type='button' className={cn(LINK, 'shrink-0 text-[11.5px]')} id='tm-what-if'>
          What if…
        </button>
      </PopoverPrimitive.Trigger>
      {open && (
        <PopoverContent
          side='bottom'
          align='end'
          className='traffic-map w-[320px] border-[var(--tm-line)] bg-[var(--tm-card)] p-3 text-[var(--tm-fg)]'
        >
          <WhatIfBodyView />
        </PopoverContent>
      )}
    </PopoverPrimitive.Root>
  )
}
