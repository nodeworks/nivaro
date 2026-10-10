/**
 * /session-replays?share=<token> — a replay window someone shared with you
 * (#1362). Rendered for any signed-in person, admin or not: the server
 * decides (the link names one person and expires), and plays only the
 * window. No list, no rail, no range actions.
 */
import { useQuery } from '@tanstack/react-query'
import { Clapperboard, Lock } from 'lucide-react'
import { ReplayPlayer } from '@/components/replay-player'
import { expiresIn, fmtSpan } from '@/components/replay-player/range'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

interface ShareHeader {
  id: string
  from_ms: number
  to_ms: number
  duration_ms: number
  expires_at: string
  created_at: string
  shared_by_name: string | null
}

/** The refusal in words a viewer can act on. */
export function shareRefusal(status: number | undefined): string {
  if (status === 403)
    return 'This replay was shared with someone else. Sign in as that person to watch it.'
  if (status === 410) return 'This replay link has expired. Ask whoever shared it for a new one.'
  if (status === 404) return 'This replay link was revoked, or the recording is no longer kept.'
  return 'This replay could not be opened.'
}

export function SharedReplay({ token }: { token: string }) {
  const enc = encodeURIComponent(token)
  const { data, error, isLoading } = useQuery({
    queryKey: ['replay-share', token],
    queryFn: () =>
      api.get<{ data: ShareHeader }>(`/session-replay-shares/view/${enc}`).then((r) => r.data.data),
    retry: false
  })
  const status = (error as { response?: { status?: number } } | null)?.response?.status

  return (
    <div className='flex flex-1 min-h-0 flex-col overflow-y-auto'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Clapperboard className='h-4 w-4 text-nvr-cyan' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Shared replay
            </h1>
            {data && (
              <p className='text-[12px] text-muted-foreground'>
                Shared with you by {data.shared_by_name || 'an administrator'}{' '}
                {formatRelative(data.created_at)} · {fmtSpan(data.duration_ms)} · link expires{' '}
                {expiresIn(data.expires_at)}
              </p>
            )}
          </div>
        </div>
      </header>
      <div className='px-8 py-5'>
        {isLoading ? (
          <p className='text-[12px] text-slate-400'>Loading…</p>
        ) : error || !data ? (
          <div className='max-w-md py-10'>
            <Lock className='h-8 w-8 text-slate-300' />
            <p className='mt-3 text-[13px] text-slate-600 dark:text-slate-300'>
              {shareRefusal(status)}
            </p>
          </div>
        ) : (
          <>
            <p className='text-[12px] text-slate-500'>
              Inputs were masked when this was recorded. Opening it is recorded in the activity log.
            </p>
            <ReplayPlayer
              recordingId={data.id}
              eventsUrl={`/session-replay-shares/view/${enc}/events`}
            />
          </>
        )}
      </div>
    </div>
  )
}
