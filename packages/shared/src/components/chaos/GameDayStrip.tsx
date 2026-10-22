import { useQuery } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { DeclareIncidentButton } from './DeclareIncidentButton'

/**
 * The drill banner's quiet sibling (#2854): while a game day this person takes part in is
 * running, a calm strip names the day and offers "Declare incident". Participants were invited
 * to the day, so naming it gives nothing away; in blind mode the faults themselves stay hidden
 * (the red drill banner does not show for responders) and Declare is how detection is timed.
 * Data: `GET /api/chaos/gamedays/active` (titles, roles and times only, never the injects).
 */

export interface ActiveGameday {
  id: string
  title: string
  status: 'planned' | 'running'
  role: 'lead' | 'scribe' | 'responder'
  starts_at: string
  started_at: string | null
  ends_at: string | null
  channel_room: string | null
}

export const ACTIVE_GAMEDAYS_KEY = ['chaos-gamedays-active'] as const

export function useActiveGamedays(enabled = true): ActiveGameday[] {
  const client = useOptionalNivaroClient()
  const { data } = useQuery<ActiveGameday[]>({
    queryKey: ACTIVE_GAMEDAYS_KEY,
    queryFn: () =>
      client!
        .request<{ data: ActiveGameday[] }>(get('/chaos/gamedays/active'))
        .then((r) => r.data ?? [])
        .catch(() => []),
    enabled: !!client && enabled,
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  return data ?? []
}

const ROLE: Record<ActiveGameday['role'], string> = {
  lead: 'you lead it',
  scribe: 'you are the scribe',
  responder: 'you are a responder'
}

export function GameDayStrip({ enabled = true }: { enabled?: boolean }) {
  const running = useActiveGamedays(enabled).filter((d) => d.status === 'running')
  if (!running.length) return null
  const day = running[0]
  return (
    <div
      role='status'
      data-gameday-strip
      data-nvr-recording-hide
      className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[12.5px] text-slate-800 dark:border-border dark:bg-muted/40 dark:text-foreground'
    >
      <span className='min-w-0 font-medium'>Game day in progress: {day.title}</span>
      <span className='min-w-0 text-slate-500 dark:text-muted-foreground'>
        {ROLE[day.role]}
        {running.length > 1 ? ` · ${running.length - 1} more running` : ''}
      </span>
      <DeclareIncidentButton className='ml-auto' />
    </div>
  )
}
