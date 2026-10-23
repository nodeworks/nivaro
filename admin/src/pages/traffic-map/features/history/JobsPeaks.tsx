/**
 * #2165 — scheduled jobs against the day's traffic: the typical day's request curve (requests per
 * minute for each hour, averaged over a week), each job drawn at its usual start for its usual
 * length (from its last two weeks of scheduled runs), and — for a job sitting in the peak — the
 * quietest start of the same length, as a cron expression to paste, with what moving it would do
 * to the pool (#2151's projection).
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { BTN, errorOf, LINK, Note, SafeLink } from '../shared'
import { type CurveBar, HistoryCurve, Swatch } from './HistoryCurve'
import {
  fmtDuration,
  fmtUtcMinute,
  type JobSlot,
  type JobsBody,
  useHistoryState,
  type WhatIfBody,
  type WhatIfFigures
} from './shared'

function poolLine(f: WhatIfFigures): string {
  return f.pool_pct != null ? `pool ${f.pool_pct}%` : `pool ${f.pool_used}`
}

function MoveProjection({ job }: { job: JobSlot }) {
  const q = useQuery({
    queryKey: ['traffic-map', 'history', 'what-if-move', job.id, job.suggest_minute_utc],
    queryFn: async () =>
      ((
        await api.get('/traffic-map/capacity/what-if', {
          params: { job: job.id, to_minute: job.suggest_minute_utc }
        })
      )?.data?.data ?? null) as WhatIfBody | null,
    staleTime: 60_000
  })
  if (q.isLoading) return <span className='text-[var(--tm-muted)]'>Loading…</span>
  if (q.isError) return <span className='text-[var(--tm-error-ink)]'>{errorOf(q.error)}</span>
  const j = q.data?.job
  if (!j) return null
  return (
    <span className='text-[var(--tm-fg-2)]' data-tm-jobs-move={job.id}>
      At its slot now: {poolLine(j.from_before)} → {poolLine(j.from_after)} without it. At the new
      slot: {poolLine(j.to_before)} → {poolLine(j.to_after)}.
    </span>
  )
}

export function JobsPeaks() {
  const st = useHistoryState()
  const q = useQuery({
    queryKey: ['traffic-map', 'history', 'jobs'],
    queryFn: async () =>
      ((await api.get('/traffic-map/history/jobs'))?.data?.data ?? null) as JobsBody | null,
    enabled: st.tab === 'jobs',
    staleTime: 10 * 60_000
  })
  const [open, setOpen] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const data = q.data ?? null
  // The curve per UTC hour, shifted so it reads in the viewer's local day from 00:00.
  const offsetH = Math.round(-new Date().getTimezoneOffset() / 60)
  const local = useMemo(
    () =>
      data
        ? Array.from({ length: 24 }, (_, h) => data.curve[(((h - offsetH) % 24) + 24) % 24])
        : [],
    [data, offsetH]
  )
  const toLocalIdx = (utcMinute: number) => (((utcMinute / 60 + offsetH) % 24) + 24) % 24
  const drawn = (data?.jobs ?? []).filter((j) => j.start_minute_utc != null)
  const bars: CurveBar[] = drawn.slice(0, 24).map((j) => {
    const from = toLocalIdx(j.start_minute_utc as number)
    return {
      id: j.id,
      from,
      to: Math.min(23, from + Math.max(0.15, j.median_ms / 3600_000)),
      label: `${j.id} · usually ${fmtUtcMinute(j.start_minute_utc as number)} for ${fmtDuration(j.median_ms)}${j.overlaps_peak ? ' · in the peak' : ''}`,
      tone: j.overlaps_peak ? 'warn' : j.heavy ? 'accent' : 'muted'
    }
  })
  const allDay = (data?.jobs ?? []).filter((j) => j.start_minute_utc == null)
  return (
    <div className='grid gap-3 p-3.5' data-tm-jobs=''>
      {q.isLoading ? (
        <div
          className='h-[150px] animate-pulse rounded-md bg-[var(--tm-skeleton)]'
          role='status'
          aria-label='Loading'
        />
      ) : q.isError ? (
        <Note tone='error'>{errorOf(q.error)}</Note>
      ) : !data ? (
        <Note>No traffic curve yet.</Note>
      ) : (
        <>
          <HistoryCurve
            label='Typical day'
            values={local}
            bars={bars}
            peak={data.peak_level}
            ticks={[0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({
              i: h,
              label: `${String(h).padStart(2, '0')}:00`
            }))}
            legend={
              <>
                <Swatch color='var(--tm-accent)'>
                  Requests per minute, a typical day (your time)
                </Swatch>
                <Swatch color='var(--tm-update)' dashed>
                  Peak
                </Swatch>
                <span>Bars: jobs at their usual start; amber = in the peak.</span>
              </>
            }
          />
          {drawn.length === 0 ? (
            <Note>No scheduled job has a usual start time in its last two weeks of runs.</Note>
          ) : (
            <table className='w-full text-[12px]' data-tm-jobs-table=''>
              <thead>
                <tr className='border-b border-[var(--tm-line-2)] text-left text-[11px] font-medium text-[var(--tm-muted)]'>
                  <th className='py-1 pr-2 font-medium'>Job</th>
                  <th className='py-1 pr-2 font-medium'>Usually</th>
                  <th className='py-1 pr-2 font-medium'>Runs for</th>
                  <th className='py-1 pr-2 font-medium'>Traffic then</th>
                  <th className='py-1 font-medium'>Quieter slot</th>
                </tr>
              </thead>
              <tbody>
                {drawn.map((j) => (
                  <tr
                    key={j.id}
                    className='border-b border-[var(--tm-line-2)] align-top'
                    data-tm-job={j.id}
                  >
                    <td className='py-1 pr-2 font-mono text-[11.5px]'>
                      {j.id}
                      {j.heavy && (
                        <span className='ml-1 font-sans text-[10.5px] text-[var(--tm-muted)]'>
                          heavy
                        </span>
                      )}
                    </td>
                    <td className='py-1 pr-2 tabular-nums'>
                      {fmtUtcMinute(j.start_minute_utc as number)}
                    </td>
                    <td className='py-1 pr-2 tabular-nums'>{fmtDuration(j.median_ms)}</td>
                    <td
                      className={cn(
                        'py-1 pr-2 tabular-nums',
                        j.overlaps_peak && 'font-medium text-[var(--tm-update)]'
                      )}
                    >
                      {j.traffic_during.toLocaleString()}/min{j.overlaps_peak ? ' · peak' : ''}
                    </td>
                    <td className='py-1'>
                      {j.suggest_minute_utc == null ? (
                        <span className='text-[var(--tm-muted)]'>
                          {j.overlaps_peak ? 'None clearly quieter' : '—'}
                        </span>
                      ) : (
                        <div className='grid gap-0.5'>
                          <span className='flex flex-wrap items-center gap-1.5'>
                            <span className='tabular-nums'>
                              {fmtUtcMinute(j.suggest_minute_utc)}
                            </span>
                            <span className='text-[var(--tm-muted)]'>
                              ({(j.suggest_traffic ?? 0).toLocaleString()}/min)
                            </span>
                            {j.suggest_expression && (
                              <button
                                type='button'
                                className={cn(BTN, 'font-mono')}
                                data-tip={`Copy the cron expression${j.timezone ? ` (in ${j.timezone})` : ''}`}
                                onClick={() => {
                                  void navigator.clipboard?.writeText(
                                    j.suggest_expression as string
                                  )
                                  setCopied(j.id)
                                }}
                              >
                                {copied === j.id ? 'Copied' : j.suggest_expression}
                              </button>
                            )}
                            <button
                              type='button'
                              className={LINK}
                              aria-expanded={open === j.id}
                              onClick={() => setOpen(open === j.id ? null : j.id)}
                            >
                              What would it change?
                            </button>
                          </span>
                          {open === j.id && <MoveProjection job={j} />}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {allDay.length > 0 && (
            <p className='text-[11.5px] text-[var(--tm-muted)]'>
              Running all day (no hour to move):{' '}
              <span className='font-mono'>
                {allDay
                  .slice(0, 12)
                  .map((j) => j.id)
                  .join(', ')}
              </span>
              {allDay.length > 12 ? ` and ${allDay.length - 12} more` : ''}.
            </p>
          )}
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Change a schedule on{' '}
            <SafeLink to='/jobs' className={LINK}>
              Background Jobs
            </SafeLink>
            . The curve is this instance&apos;s request log over the last 7 days; the jobs are their
            scheduled runs over 14 days.
          </p>
        </>
      )}
    </div>
  )
}
