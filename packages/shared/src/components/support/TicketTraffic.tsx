import { useQuery } from '@tanstack/react-query'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

interface TicketTrafficData {
  moment: number
  requests: number
  errors: number
  timeline: Array<{ n: number; e: number }>
  areas: Array<{ path: string; n: number; errors: number }>
  error_list: Array<{ at: number; method: string; path: string; status: number }>
  pages: Array<{ route: string; n: number; avg_ms: number | null; worst_ms: number | null }>
  truncated: boolean
  rum: boolean
  /** Epoch seconds for the map's ?at= link; null unless the viewer is an administrator. */
  map_at: number | null
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * #2276 — what the requester's browser did around the moment they raised the ticket: requests,
 * errors and pages for 30 minutes either side. Shown to whoever works the ticket (the server
 * refuses everyone else), with a link to that moment on the Traffic Map for administrators.
 */
export function TicketTraffic({ ticketId }: { ticketId: number }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const { data, isLoading } = useQuery({
    queryKey: ['support-ticket-traffic', ticketId],
    queryFn: () =>
      client
        .request<{ data: TicketTrafficData | null }>(get(`/support/tickets/${ticketId}/traffic`))
        .then((r) => r.data),
    staleTime: 60_000,
    retry: false
  })
  if (isLoading || !data) return null
  const peak = Math.max(1, ...data.timeline.map((t) => t.n))
  const mapPath = data.map_at != null ? `/traffic-map?at=${data.map_at}` : null
  const mapHref = mapPath ? (nav.consoleUrl ? nav.consoleUrl(mapPath) : mapPath) : null
  return (
    <section data-ticket-traffic={data.requests}>
      <div className='mb-1.5 flex items-baseline justify-between gap-2'>
        <h3 className='text-[11px] font-semibold text-slate-500 dark:text-muted-foreground'>
          Their traffic around {clock(data.moment)}
        </h3>
        {mapHref && (
          <a
            href={mapHref}
            target='_blank'
            rel='noreferrer'
            data-ticket-traffic-map=''
            className='text-[12px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
          >
            Open that moment on the map
          </a>
        )}
      </div>
      {data.requests === 0 && data.pages.length === 0 ? (
        <p className='text-[12.5px] text-slate-400'>
          Nothing was recorded for them in the hour around this request.
        </p>
      ) : (
        <div className='grid gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'>
          <p>
            {data.requests.toLocaleString()} request{data.requests === 1 ? '' : 's'},{' '}
            <span className={data.errors ? 'font-medium text-red-600 dark:text-red-400' : ''}>
              {data.errors.toLocaleString()} error{data.errors === 1 ? '' : 's'}
            </span>
            , 30 minutes either side.
            {data.truncated ? ' Only the newest are counted.' : ''}
          </p>
          <div
            className='flex h-8 items-end gap-px'
            role='img'
            aria-label='Requests per minute around the ticket'
          >
            {data.timeline.map((t, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed minute slots
                key={i}
                className={`min-w-0 flex-1 rounded-sm ${
                  t.e ? 'bg-red-500/70' : 'bg-slate-300 dark:bg-slate-600'
                } ${i === 30 ? 'outline outline-1 outline-nvr-cyan' : ''}`}
                style={{ height: `${Math.max(t.n ? 8 : 2, (t.n / peak) * 100)}%` }}
              />
            ))}
          </div>
          {data.error_list.length > 0 && (
            <ul className='grid gap-0.5' data-ticket-traffic-errors=''>
              {data.error_list.slice(0, 6).map((e) => (
                <li key={`${e.at}-${e.method}-${e.path}`} className='flex min-w-0 gap-2'>
                  <span className='shrink-0 tabular-nums text-slate-400'>{clock(e.at)}</span>
                  <span className='shrink-0 font-medium text-red-600 dark:text-red-400'>
                    {e.status}
                  </span>
                  <span className='min-w-0 truncate font-mono text-[11.5px]'>
                    {e.method} {e.path}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.pages.length > 0 && (
            <p className='text-slate-600 dark:text-slate-300'>
              Pages:{' '}
              {data.pages
                .slice(0, 4)
                .map(
                  (p) =>
                    `${p.route}${p.n > 1 ? ` x${p.n}` : ''}${p.worst_ms ? ` (slowest ${(p.worst_ms / 1000).toFixed(1)} s)` : ''}`
                )
                .join(', ')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
