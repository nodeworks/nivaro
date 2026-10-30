import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Section, SectionEmpty, SectionError, type SectionProps, Surface } from './kit'
import { bucketSummary, bucketTone } from './timeline-text'
import type { MarkKind, OverviewTimeline, TimelineBucket, TimelineMark } from './types'

/**
 * #16 Today on this instance (administrators) — the last 24 hours as a strip of half-hour slots:
 * scheduled job runs (failures stand out), deploys / version changes, imports and config changes
 * (GET /api/overview/timeline, admin-only). Hover or focus a slot for its words; click opens
 * what happened in it. "List" shows the same as a plain list (and screen readers get it too).
 */

export function useOverviewTimeline() {
  return useQuery({
    queryKey: ['overview', 'timeline'],
    queryFn: () =>
      api.get<{ data: OverviewTimeline }>('/overview/timeline').then((r) => r.data.data),
    staleTime: 60_000,
    refetchInterval: 120_000
  })
}

const MARK: Record<ReturnType<typeof bucketTone>, string> = {
  failed: 'h-5 bg-rose-500 dark:bg-rose-400',
  deploy: 'h-5 bg-nvr-cyan',
  change: 'h-3.5 bg-slate-500 dark:bg-slate-300',
  jobs: 'h-2 bg-slate-300 dark:bg-slate-600',
  empty: 'h-px bg-slate-200 dark:bg-border'
}

const KIND_WORD: Record<MarkKind, string> = {
  job: 'Job',
  deploy: 'Deploy',
  import: 'Import',
  config: 'Config'
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function slotName(b: TimelineBucket) {
  return `${clock(b.start)} to ${clock(b.end)}`
}

function MarkLine({ m }: { m: TimelineMark }) {
  return (
    <li className='flex items-baseline gap-2 py-1 text-[12.5px]'>
      <span className='w-16 shrink-0 tabular-nums text-[11.5px] text-slate-400'>{clock(m.at)}</span>
      <span
        className={cn(
          'w-14 shrink-0 text-[11px]',
          m.failed
            ? 'font-medium text-rose-600 dark:text-rose-400'
            : 'text-slate-500 dark:text-slate-400'
        )}
      >
        {m.failed ? 'Failed' : KIND_WORD[m.kind]}
      </span>
      <Link
        to={m.href}
        className='min-w-0 flex-1 truncate text-slate-700 hover:underline dark:text-slate-200'
      >
        {m.sentence}
      </Link>
    </li>
  )
}

export function TimelineSection({ hideTitle }: SectionProps = {}) {
  const { data, isLoading, isError, error, refetch } = useOverviewTimeline()
  const [open, setOpen] = useState<number | null>(null)
  const [asList, setAsList] = useState(false)

  const ticks = useMemo(() => {
    if (!data) return []
    const n = data.buckets.length
    return [0, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4)].map((i) => ({
      i,
      label: data.buckets[i] ? clock(data.buckets[i].start) : ''
    }))
  }, [data])

  const sum = (f: (b: TimelineBucket) => number) => data?.buckets.reduce((s, b) => s + f(b), 0) ?? 0
  const failedTotal = sum((b) => b.failed)
  const deploys = sum((b) => b.kinds.deploy)
  const changes = sum((b) => b.kinds.import + b.kinds.config)
  const picked = open != null ? data?.buckets[open] : null

  return (
    <Section id='timeline' title='Today on this instance' hideTitle={hideTitle}>
      {isLoading ? (
        <Surface className='px-3 py-3'>
          <div className='flex h-6 items-end gap-[3px]'>
            {Array.from({ length: 48 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
              <Skeleton key={i} className='h-3 flex-1 rounded-sm' />
            ))}
          </div>
          <Skeleton className='mt-2 h-3 w-40' />
        </Surface>
      ) : isError || !data ? (
        <SectionError error={error} what="today's timeline" onRetry={() => void refetch()} />
      ) : data.buckets.every((b) => b.total === 0) ? (
        <SectionEmpty next={{ label: 'See scheduled jobs', to: '/jobs' }}>
          Nothing ran on this instance in the last 24 hours.
        </SectionEmpty>
      ) : (
        <Surface className='relative px-3 py-3'>
          <div className='mb-2 flex flex-wrap items-baseline justify-between gap-2'>
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              {failedTotal > 0
                ? `${failedTotal} ${failedTotal === 1 ? 'thing' : 'things'} failed`
                : 'Nothing failed'}
              {deploys > 0 && ` · ${deploys} ${deploys === 1 ? 'deploy' : 'deploys'}`}
              {changes > 0 &&
                ` · ${changes} ${changes === 1 ? 'import or config change' : 'imports and config changes'}`}
              {` · ${data.routine_jobs} routine job ${data.routine_jobs === 1 ? 'run' : 'runs'}`}
            </p>
            <button
              type='button'
              aria-pressed={asList}
              onClick={() => setAsList((v) => !v)}
              className='text-[11.5px] font-medium text-slate-600 hover:underline dark:text-slate-300'
            >
              {asList ? 'Show as strip' : 'Show as list'}
            </button>
          </div>

          {!asList && (
            <>
              {/* biome-ignore lint/a11y/useSemanticElements: a strip of slot buttons, not a form field group */}
              <div
                role='group'
                aria-label='The last 24 hours in half-hour slots'
                className='flex h-6 items-end gap-[3px]'
              >
                {data.buckets.map((b, i) => {
                  const words = `${slotName(b)}: ${bucketSummary(b)}`
                  return (
                    <button
                      key={b.start}
                      type='button'
                      disabled={b.total === 0}
                      aria-label={words}
                      aria-expanded={open === i}
                      data-tip={
                        b.total
                          ? [words, ...b.sample.map((m) => `· ${m.sentence}`)].join('\n')
                          : undefined
                      }
                      onClick={() => setOpen(open === i ? null : i)}
                      className={cn(
                        'group flex h-full flex-1 items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                        b.total > 0 && 'cursor-pointer hover:bg-muted',
                        open === i && 'bg-muted'
                      )}
                    >
                      <span className={cn('block w-full rounded-sm', MARK[bucketTone(b)])} />
                    </button>
                  )
                })}
              </div>
              <div
                className='relative mt-1 h-4 text-[10.5px] tabular-nums text-slate-400'
                aria-hidden
              >
                {ticks.map((t) => (
                  <span
                    key={t.i}
                    className='absolute'
                    style={{ left: `${(t.i / data.buckets.length) * 100}%` }}
                  >
                    {t.label}
                  </span>
                ))}
                <span className='absolute right-0'>now</span>
              </div>
              <ul
                className='mt-1 flex flex-wrap gap-x-3 text-[10.5px] text-slate-500 dark:text-slate-400'
                aria-label='Legend'
              >
                <li className='inline-flex items-center gap-1'>
                  <span className='h-2 w-2 rounded-sm bg-rose-500 dark:bg-rose-400' aria-hidden />
                  Failed
                </li>
                <li className='inline-flex items-center gap-1'>
                  <span className='h-2 w-2 rounded-sm bg-nvr-cyan' aria-hidden />
                  Deploy
                </li>
                <li className='inline-flex items-center gap-1'>
                  <span className='h-2 w-2 rounded-sm bg-slate-500 dark:bg-slate-300' aria-hidden />
                  Import or config change
                </li>
                <li className='inline-flex items-center gap-1'>
                  <span className='h-2 w-2 rounded-sm bg-slate-300 dark:bg-slate-600' aria-hidden />
                  Job runs only
                </li>
              </ul>
              {picked && (
                <div
                  className='mt-3 border-t border-slate-100 pt-2 dark:border-border'
                  aria-live='polite'
                >
                  <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                    {slotName(picked)} · {bucketSummary(picked)}
                  </p>
                  {picked.sample.length > 0 && (
                    <ul className='mt-1'>
                      {picked.sample.map((m) => (
                        <MarkLine key={`${m.at}-${m.sentence}`} m={m} />
                      ))}
                    </ul>
                  )}
                  {picked.total > picked.sample.length && (
                    <Link
                      to='/jobs/timeline'
                      className='text-[11.5px] text-slate-500 hover:underline'
                    >
                      {picked.total - picked.sample.length} more in the job timeline
                    </Link>
                  )}
                </div>
              )}
            </>
          )}

          <div className={asList ? undefined : 'sr-only'}>
            {data.notable.length === 0 ? (
              <p className='text-[12px] text-slate-500'>Only routine job runs today.</p>
            ) : (
              <ul aria-label='What happened today, newest first'>
                {data.notable.map((m) => (
                  <MarkLine key={`${m.at}-${m.kind}-${m.sentence}`} m={m} />
                ))}
              </ul>
            )}
          </div>
        </Surface>
      )}
    </Section>
  )
}
