import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatNumber } from '../../lib/utils'

interface QueueOwner {
  id: string
  name: string
}

interface WorkloadRow {
  owner: QueueOwner | null
  count: number
  max_wip: number | null
}

export function QueueWorkloadView({ queueId }: { queueId: string }) {
  const client = useNivaroClient()

  const { data, isLoading } = useQuery<{ data: WorkloadRow[] }>({
    queryKey: ['queue-workload', queueId],
    queryFn: () => client.request(get(`/queues/${queueId}/workload`))
  })

  const rows = data?.data ?? []

  if (isLoading) {
    return <p className='py-12 text-center text-[13px] text-slate-400'>Loading…</p>
  }
  if (rows.length === 0) {
    return <p className='py-12 text-center text-[13px] text-slate-400'>Nothing in this queue.</p>
  }

  return (
    <div className='space-y-2'>
      {rows.map((row) => {
        const overLimit = row.max_wip != null && row.count > row.max_wip
        return (
          <div
            key={row.owner?.id ?? '__unassigned__'}
            className='flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
          >
            <span className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>
              {row.owner?.name ?? 'Unassigned'}
            </span>
            <div className='flex items-center gap-2'>
              <span
                className={cn(
                  'rounded px-2 py-0.5 text-[12px] font-semibold tabular-nums',
                  overLimit
                    ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                    : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
                )}
              >
                {formatNumber(row.count)}
                {row.max_wip != null ? ` / ${formatNumber(row.max_wip)}` : ''}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
