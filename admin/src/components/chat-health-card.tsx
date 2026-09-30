import { useQuery } from '@tanstack/react-query'
import { MessagesSquare, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/**
 * Chat health (#989) on the Ops Console: is chat working right now?
 * Sockets connected, messages sent and failed, how long a send takes on the
 * server and how late messages reach the browsers that sampled them — the
 * last hour on this replica.
 */

interface ChatHealth {
  window_minutes: number
  sockets: number
  sends: number
  failed_sends: number
  send_ms: { p50: number | null; p95: number | null }
  delivery_ms: { p50: number | null; p95: number | null; samples: number }
  recent_failures: Array<{ at: string; error: string }>
  stored_last_hour: number
  scheduled_pending: number
  scheduled_failed: number
}

function ms(v: number | null): string {
  if (v == null) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`
}

export function ChatHealthCard() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['ops-chat-health'],
    queryFn: () => api.get<{ data: ChatHealth }>('/chat/admin/health').then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const bad =
    (data?.failed_sends ?? 0) > 0 ||
    (data?.delivery_ms.p95 ?? 0) > 5000 ||
    (data?.send_ms.p95 ?? 0) > 3000
  const tiles: Array<{ label: string; value: string; tone?: 'bad' }> = data
    ? [
        { label: 'Sockets connected', value: String(data.sockets) },
        { label: 'Sent (this replica)', value: String(data.sends) },
        {
          label: 'Failed sends',
          value: String(data.failed_sends),
          tone: data.failed_sends > 0 ? 'bad' : undefined
        },
        {
          label: 'Send time p50 / p95',
          value: `${ms(data.send_ms.p50)} / ${ms(data.send_ms.p95)}`
        },
        {
          label: 'Delivery p50 / p95',
          value: data.delivery_ms.samples
            ? `${ms(data.delivery_ms.p50)} / ${ms(data.delivery_ms.p95)}`
            : 'No samples yet',
          tone: (data.delivery_ms.p95 ?? 0) > 5000 ? 'bad' : undefined
        },
        { label: 'Stored (all replicas)', value: String(data.stored_last_hour) },
        {
          label: 'Scheduled waiting',
          value: `${data.scheduled_pending}${data.scheduled_failed ? ` · ${data.scheduled_failed} failed` : ''}`,
          tone: data.scheduled_failed ? 'bad' : undefined
        }
      ]
    : []
  return (
    <section
      data-ops-chat-health={bad ? 'attention' : 'ok'}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <div className='flex items-center gap-2'>
          <MessagesSquare className='h-4 w-4 text-slate-400' />
          <div>
            <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              Chat health
            </h2>
            <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              Last {data?.window_minutes ?? 60} minutes on this replica — delivery is timed by a
              sample of the browsers that received messages
            </p>
          </div>
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-7 text-[11.5px]'
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`mr-1 h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </header>
      <div className='p-4'>
        {isLoading ? (
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7'>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className='h-12 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
            ))}
          </div>
        ) : (
          <>
            <dl className='grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7'>
              {tiles.map((t) => (
                <div key={t.label} data-ops-chat-tile={t.label}>
                  <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {t.label}
                  </dt>
                  <dd
                    className={`mt-0.5 text-[15px] font-semibold tabular-nums ${
                      t.tone === 'bad'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-slate-800 dark:text-foreground'
                    }`}
                  >
                    {t.value}
                  </dd>
                </div>
              ))}
            </dl>
            {data?.recent_failures.length ? (
              <ul className='mt-3 space-y-1 border-t border-slate-100 pt-3 text-[11.5px] dark:border-border/60'>
                {data.recent_failures.map((f) => (
                  <li key={f.at} className='flex gap-3'>
                    <span className='shrink-0 tabular-nums text-slate-500'>
                      {new Date(f.at).toLocaleTimeString()}
                    </span>
                    <span className='text-red-700 dark:text-red-300'>{f.error}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
