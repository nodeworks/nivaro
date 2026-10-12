import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigation, useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLiveAvailable, useLiveEvent, useLiveWatchRoom } from '../../lib/live'
import { formatRelative } from '../../lib/utils'

/**
 * Incident mode banner (#2016) — administrators only. While incident mode is
 * on, a slim strip across the app: "Incident in progress: <title> · started
 * <relative> · Open thread". Turning it on or off sends a payload-free
 * `ops:incident` notice to the tenant's admin watch room (`ops`, joined only
 * by administrators); the tab then re-reads GET /ops-assistant/incident,
 * which is admin-only. The poll under it catches a missed notice.
 *
 * Render it only for administrators (`enabled`): a non-admin tab never joins
 * the room or asks the route. Mount once in the app shell's banner stack.
 */

export interface IncidentNow {
  id: number
  title: string
  started_at: string
  room: string | null
  root_message_id: number | null
}

export const INCIDENT_QUERY_KEY = ['nvr-ops-incident-banner'] as const

/** The thread link: the ops channel, with the incident's root message. */
export function incidentThreadPath(
  i: Pick<IncidentNow, 'room' | 'root_message_id'>
): string | null {
  if (!i.room) return null
  const q = new URLSearchParams({ room: i.room })
  if (i.root_message_id) q.set('thread', String(i.root_message_id))
  return `/chat?${q.toString()}`
}

export function IncidentBanner({
  enabled,
  threadPath = incidentThreadPath
}: {
  /** True only for administrators. */
  enabled: boolean
  /** Where "Open thread" goes (a host with its own chat route maps it). */
  threadPath?: (i: IncidentNow) => string | null
}) {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const nav = useNavigation()
  const on = enabled && !!client
  const live = useLiveAvailable()
  useLiveWatchRoom('ops', on)
  useLiveEvent('ops:incident', () => void qc.invalidateQueries({ queryKey: INCIDENT_QUERY_KEY }), {
    debounceMs: 200,
    includeOwn: true,
    enabled: on
  })
  const { data: incident } = useQuery<IncidentNow | null>({
    queryKey: INCIDENT_QUERY_KEY,
    queryFn: () =>
      client!
        .request<{ data: { current: IncidentNow | null } }>(get('/ops-assistant/incident'))
        .then((r) => r.data?.current ?? null)
        .catch(() => null),
    enabled: on,
    refetchInterval: live ? 300_000 : 60_000
  })
  if (!on || !incident) return null
  const href = threadPath(incident)
  return (
    <div
      className='flex shrink-0 items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-1.5 dark:border-red-500/30 dark:bg-red-500/10'
      data-incident-banner={incident.id}
      data-nvr-recording-hide
    >
      <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-500' />
      <span className='min-w-0 flex-1 truncate text-[12.5px] text-red-800 dark:text-red-300'>
        <b className='font-semibold'>Incident in progress:</b> {incident.title}
        <span className='text-red-700/80 dark:text-red-300/80'>
          {' '}
          · started {formatRelative(incident.started_at)}
        </span>
      </span>
      {href && (
        <a
          href={href}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) return
            e.preventDefault()
            nav.navigate(href)
          }}
          className='shrink-0 text-[11.5px] font-medium text-red-800 underline decoration-dotted underline-offset-2 hover:text-red-900 dark:text-red-200'
          data-incident-thread
        >
          Open thread
        </a>
      )}
    </div>
  )
}
