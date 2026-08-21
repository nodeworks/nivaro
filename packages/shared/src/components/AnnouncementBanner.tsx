import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOptionalNivaroClient } from './../context'
import { get, post } from '../lib/commands'

/**
 * Admin-authored announcement banners ("maintenance Friday 6pm") — polled
 * every minute, role/window-filtered server-side, dismiss = acknowledge
 * (stays gone for that user, admins see ack counts). Mount once per app
 * shell; renders nothing when there is nothing to say.
 */
export function AnnouncementBanner() {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const { data: items = [] } = useQuery<
    Array<{ id: number; message: string; severity: string }>
  >({
    queryKey: ['announcements-active'],
    queryFn: () =>
      client!
        .request<{ data: Array<{ id: number; message: string; severity: string }> }>(
          get('/announcements/active')
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    enabled: !!client,
    refetchInterval: 60_000
  })
  if (items.length === 0) return null
  return (
    <div data-announcements className='shrink-0'>
      {items.map((a) => (
        <div
          key={a.id}
          className={
            a.severity === 'critical'
              ? 'flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2 dark:border-red-500/30 dark:bg-red-500/10'
              : a.severity === 'warn'
                ? 'flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-500/30 dark:bg-amber-400/10'
                : 'flex items-center gap-3 border-b border-sky-200 bg-sky-50 px-4 py-2 dark:border-sky-500/30 dark:bg-sky-500/10'
          }
        >
          <span
            className={
              a.severity === 'critical'
                ? 'min-w-0 flex-1 text-[12.5px] text-red-800 dark:text-red-300'
                : a.severity === 'warn'
                  ? 'min-w-0 flex-1 text-[12.5px] text-amber-800 dark:text-amber-300'
                  : 'min-w-0 flex-1 text-[12.5px] text-sky-800 dark:text-sky-300'
            }
          >
            {a.message}
          </span>
          {(a as { dismissable?: boolean }).dismissable !== false && (
            <button
              type='button'
              onClick={() =>
                void client
                  ?.request(post(`/announcements/${a.id}/ack`, {}))
                  .then(() => qc.invalidateQueries({ queryKey: ['announcements-active'] }))
              }
              className='shrink-0 text-[11.5px] font-medium text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-700 dark:text-muted-foreground'
            >
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
