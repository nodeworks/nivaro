import { ErrorNotice } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'
import type { TimelineMark } from '../sections/types'
import type { TodayCtx } from './TodaySheet'

/**
 * One half-hour slot of "Today on this instance" → every event in it (GET
 * /overview/timeline/slot, read from the strip's own remembered answer, so the count matches
 * the bar). A job run opens its detail, a config change its activity entry; imports and
 * deploys open their own pages.
 */

interface Slot {
  start: string
  end: string
  total: number
  marks: Array<TimelineMark & { run_id?: number; activity_id?: number }>
}

const KIND_WORD: Record<string, string> = {
  job: 'Job',
  deploy: 'Deploy',
  import: 'Import',
  config: 'Config'
}
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function SlotRoot({ ctx }: { ctx: TodayCtx }) {
  const navigate = useNavigate()
  const at = ctx.drill.at ?? ''
  const q = useQuery({
    queryKey: ['overview', 'timeline', 'slot', at],
    queryFn: () =>
      api
        .get<{ data: Slot }>('/overview/timeline/slot', { params: { start: at } })
        .then((r) => r.data.data),
    enabled: !!at,
    staleTime: 60_000,
    retry: false
  })
  if (q.isLoading)
    return <div className='m-4 h-48 animate-pulse rounded-lg bg-white dark:bg-card' aria-busy />
  if (q.error || !q.data)
    return (
      <div className='p-4'>
        <ErrorNotice
          error={q.error}
          what='this part of the timeline'
          onRetry={() => void q.refetch()}
        />
      </div>
    )
  const failed = q.data.marks.filter((m) => m.failed).length
  return (
    <div className='flex flex-col gap-3 p-4'>
      <p className='text-[13px] text-slate-600 dark:text-slate-300'>
        {clock(q.data.start)} to {clock(q.data.end)} ·{' '}
        <span className='font-semibold tabular-nums text-slate-900 dark:text-slate-50'>
          {formatNumber(q.data.total)}
        </span>{' '}
        {q.data.total === 1 ? 'event' : 'events'}
        {failed > 0 && (
          <span className='text-rose-700 dark:text-rose-300'> · {formatNumber(failed)} failed</span>
        )}
      </p>
      <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
        {q.data.marks.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: marks have no id of their own
          <li key={`${m.at}-${i}`}>
            <button
              type='button'
              onClick={() =>
                m.run_id
                  ? ctx.go({ ...ctx.drill, run: m.run_id })
                  : m.activity_id
                    ? ctx.go({ ...ctx.drill, entry: m.activity_id })
                    : navigate(m.href)
              }
              className='group flex w-full items-baseline gap-3 px-4 py-2 text-left text-[12.5px] hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-white/[0.03]'
            >
              <span className='w-16 shrink-0 tabular-nums text-[11.5px] text-slate-500'>
                {clock(m.at)}
              </span>
              <span
                className={cn(
                  'w-14 shrink-0 text-[11px]',
                  m.failed
                    ? 'font-medium text-rose-600 dark:text-rose-400'
                    : 'text-slate-500 dark:text-slate-400'
                )}
              >
                {m.failed ? 'Failed' : (KIND_WORD[m.kind] ?? m.kind)}
              </span>
              <span className='min-w-0 flex-1 text-slate-800 dark:text-slate-100'>
                {m.sentence}
              </span>
              <ChevronRight
                className='h-4 w-4 shrink-0 self-center text-slate-300 group-hover:text-slate-500'
                aria-hidden
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
