import { useQuery } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { useItemNavigation, useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn, formatRelative, titleCase } from '../lib/utils'

/**
 * #43 — the records this person opened most recently, with each one's
 * current pipeline state, as a rail for a home page. Reads the same
 * per-user view watermarks the "since you last looked" recap uses. Opens
 * records through the host's item navigation. Needs `<NivaroProvider>`.
 */
interface RecentRecord {
  collection: string
  item_id: string
  label: string
  state: { key: string; label: string; color: string | null } | null
  last_viewed_at: string
}

export function RecentRecordsRail({
  limit = 8,
  title = 'Recently viewed',
  className
}: {
  limit?: number
  title?: string
  className?: string
}) {
  const client = useNivaroClient()
  const nav = useItemNavigation()
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['recent-records', limit],
    queryFn: () =>
      client
        .request<{ data: RecentRecord[] }>(get('/record-views/recent', { limit }))
        .then((r) => r.data ?? [])
        .catch(() => [] as RecentRecord[]),
    staleTime: 30_000
  })
  return (
    <div className={cn('flex flex-col', className)} data-recent-records>
      <div className='mb-3 flex items-center justify-between'>
        <h2 className='text-[11px] font-medium text-slate-500'>{title}</h2>
      </div>
      <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
        {isLoading ? (
          <p className='px-4 py-3 text-[12px] text-slate-400'>Loading…</p>
        ) : rows.length === 0 ? (
          <p className='px-4 py-3 text-[12px] text-slate-400'>
            Records you open will show up here.
          </p>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border/60'>
            {rows.map((r) => (
              <li key={`${r.collection}:${r.item_id}`}>
                <button
                  type='button'
                  onClick={() => nav.open({ collection: r.collection, itemId: r.item_id })}
                  className='flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted'
                  data-recent-record={`${r.collection}:${r.item_id}`}
                >
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                      {r.label}
                    </span>
                    <span className='block truncate text-[10.5px] text-slate-400'>
                      {titleCase(r.collection)}
                    </span>
                  </span>
                  {r.state && (
                    <span
                      className='shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold'
                      style={{
                        backgroundColor: `${r.state.color ?? '#64748b'}1f`,
                        color: r.state.color ?? '#475569'
                      }}
                    >
                      {r.state.label}
                    </span>
                  )}
                  <span className='inline-flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums text-slate-400'>
                    <Clock className='h-3 w-3' />
                    {formatRelative(r.last_viewed_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
