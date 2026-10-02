/**
 * "Watch what they saw" — under a request (and inside an issue without its own replay): finds the
 * session recording of that person covering that moment and opens it as a level. With none, says
 * why and offers the recording level's "follow this person".
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { fmtDuration, requestFactsOf } from './logic'
import { Note } from './ui'

type Pick =
  | { found: true; recording_id: string; offset_ms: number; clip: boolean; distance_ms: number }
  | { found: false; none: true; reason: string }

export function WatchWhatTheySaw({
  user,
  at,
  name
}: {
  user: string
  at: number
  name?: string | null
}) {
  const q = useQuery<Pick>({
    queryKey: ['tm-inspect-recording-for', user.toUpperCase(), Math.round(at / 1000)],
    queryFn: async () =>
      (
        await api.get('/traffic-map/inspect/recording-for', {
          params: { user, at: Math.round(at) }
        })
      ).data.data as Pick,
    staleTime: 60_000,
    retry: false
  })
  const who = name || 'this person'
  if (q.isLoading)
    return (
      <div
        className='h-3.5 w-40 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
        aria-hidden='true'
      />
    )
  if (q.isError || !q.data) return <Note hook='watch-failed'>Could not look up recordings.</Note>
  const p = q.data
  if (p.found) {
    return (
      <div
        className='flex flex-wrap items-baseline gap-x-2 text-[12px]'
        data-tm-inspect-watch={p.recording_id}
      >
        <InspectLink
          inspectRef={{
            kind: 'recording',
            id: p.recording_id,
            at,
            label: `${p.clip ? 'Error clip' : 'Recording'} · ${name ?? 'what they saw'}`
          }}
        >
          Watch what they saw
        </InspectLink>
        {p.clip && (
          <span className='text-[var(--tm-muted)]'>
            error clip{p.distance_ms ? `, ${fmtDuration(p.distance_ms)} from this moment` : ''}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className='grid gap-1' data-tm-inspect-watch='none'>
      <Note hook='watch-none'>{p.reason}</Note>
      <InspectLink
        inspectRef={{ kind: 'recording', id: `for:${user}`, at, label: `Follow ${who}` }}
        className='text-[12px]'
        peek={false}
      >
        Follow {who} from now on
      </InspectLink>
    </div>
  )
}

/** Footer under `request` levels: the person + time the request detail names. */
export function RequestWatchFooter(props: InspectPanelProps) {
  const q = useInspectDetail<unknown>(props.inspectRef, props.anchor, props.windowSec)
  if (!q.data) return null
  const f = requestFactsOf(q.data)
  if (!f.user || !f.at) return null
  return (
    <section className='grid gap-1' data-tm-inspect-footer='watch'>
      <h3 className='text-[12px] font-medium text-[var(--tm-muted)]'>What they saw</h3>
      <WatchWhatTheySaw user={f.user} at={f.at} />
    </section>
  )
}
