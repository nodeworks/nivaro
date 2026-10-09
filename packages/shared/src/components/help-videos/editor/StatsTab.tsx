import { useQuery } from '@tanstack/react-query'
import { AlertCircle, RotateCw } from 'lucide-react'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Skeleton } from '../../ui/skeleton'
import { helpVideoApi } from '../api'
import type { HelpVideoDto } from '../types'

export function StatsTab({ video }: { video: HelpVideoDto }) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['help-videos', 'analytics', video.id],
    queryFn: () => helpVideoApi(client).analytics(video.id)
  })
  const a = q.data
  if (q.error)
    return (
      <div
        className='flex items-center gap-2 p-5 text-[13px] text-rose-700 dark:text-rose-300'
        role='alert'
      >
        <AlertCircle className='h-4 w-4' aria-hidden />
        <span>The stats couldn't load. {(q.error as Error).message}</span>
        <Button size='sm' variant='outline' className='h-7' onClick={() => void q.refetch()}>
          <RotateCw className='!size-3.5' /> Try again
        </Button>
      </div>
    )
  if (!a)
    return (
      <div
        className='max-w-[760px] space-y-4 p-5'
        role='status'
        aria-busy='true'
        aria-label='Loading stats'
      >
        <Skeleton className='h-16 w-full' />
        <Skeleton className='h-28 w-full' />
      </div>
    )
  if (!a.unique_viewers)
    return (
      <div className='max-w-[65ch] space-y-1 p-5 text-[13px]' data-hv-stats-empty>
        <p className='font-medium text-foreground'>Nobody has watched this yet.</p>
        <p className='text-muted-foreground'>
          Once people watch, you will see how many finished it and where they stopped.
        </p>
      </div>
    )
  return (
    <div className='max-w-[760px] space-y-6 p-5 text-[13px]' data-hv-stats>
      <dl className='grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3'>
        {[
          ['People who watched', String(a.unique_viewers)],
          ['Watched most of it', `${Math.round(a.completion_rate * 100)}%`],
          ['Hours watched', String(a.watched_hours)]
        ].map(([k, v]) => (
          <div key={k} className='bg-card p-3'>
            <dt className='text-[12px] text-muted-foreground'>{k}</dt>
            <dd className='text-[18px] font-semibold tabular-nums text-foreground'>{v}</dd>
          </div>
        ))}
      </dl>
      <section>
        <h3 className='mb-2 text-[13px] font-semibold text-foreground'>Where people stop</h3>
        <p className='sr-only'>Share of viewers who reached each part of the video.</p>
        <div
          className='flex h-28 items-end gap-1 border-b border-border'
          aria-hidden
          data-hv-dropoff
        >
          {a.drop_off.map((v, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5% sections
              key={i}
              className='flex-1 rounded-t-sm bg-nvr-navy dark:bg-nvr-cyan'
              style={{ height: `${Math.max(2, v * 100)}%` }}
              title={`${i * 5}–${i * 5 + 5}% of the video: ${Math.round(v * 100)}% of viewers`}
            />
          ))}
        </div>
        <ul className='sr-only' data-hv-dropoff-list>
          {a.drop_off.map((v, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5% sections
            <li key={i}>
              {i * 5}–{i * 5 + 5}% of the video: {Math.round(v * 100)}% of viewers still watching
            </li>
          ))}
        </ul>
        <div className='mt-1 flex justify-between text-[12px] text-muted-foreground'>
          <span>Start</span>
          <span>End</span>
        </div>
      </section>
    </div>
  )
}
