import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CalendarPlus, ExternalLink, Headphones } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { del, get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import {
  downloadIcs,
  formatScheduleWhen,
  formatStartsIn,
  type HuddleScheduleCardData,
  outlookComposeUrl,
  schedulePhase
} from './huddle-schedule'
import { huddleStore } from './huddle-store'

/**
 * The card a scheduled huddle's message renders (#2860): title, when, who;
 * Join while it is on, a countdown before, the calendar actions always, and
 * Cancel for the organizer. It reads the row, not the message, so an edit
 * or a cancellation shows everywhere the card does.
 */
export function HuddleScheduleCard({
  id,
  mine,
  renderAvatar,
  roomUrl
}: {
  id: number
  /** The message is mine (the card sits in my bubble). */
  mine?: boolean
  renderAvatar: (id: string, name: string | null) => ReactNode
  /** An absolute link to the room, for the calendar entry (null = none). */
  roomUrl?: string | null
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['nvr-huddle-schedule', id],
    queryFn: () =>
      client
        .request<{ data: HuddleScheduleCardData }>(get(`/chat/huddle/schedules/${id}`))
        .then((r) => r.data),
    staleTime: 30_000,
    refetchInterval: (q) => {
      const d = q.state.data
      if (!d) return false
      const phase = schedulePhase(d)
      return phase === 'ended' || phase === 'cancelled' ? false : 60_000
    },
    retry: false
  })
  // The countdown and the phase move on their own clock.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const [confirm, setConfirm] = useState(false)
  const cancel = useMutation({
    mutationFn: () => client.request(del(`/chat/huddle/schedules/${id}`)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-huddle-schedule', id] })
      toast.success('Huddle cancelled')
    },
    onError: () => toast.error('Could not cancel it')
  })

  const shell = cn(
    'mt-1 w-[300px] max-w-full rounded-lg border px-3 py-2.5 text-left',
    mine
      ? 'border-white/40 bg-white/95 text-slate-800 dark:border-white/20 dark:bg-card dark:text-slate-100'
      : 'border-slate-200 bg-white text-slate-800 dark:border-border dark:bg-card dark:text-slate-100'
  )

  if (isLoading && !data) {
    return (
      <div className={shell} aria-busy='true' data-huddle-card='loading'>
        <div className='h-3.5 w-2/3 animate-pulse rounded bg-slate-200 dark:bg-white/10' />
        <div className='mt-2 h-3 w-1/2 animate-pulse rounded bg-slate-200 dark:bg-white/10' />
        <div className='mt-3 h-7 w-24 animate-pulse rounded bg-slate-200 dark:bg-white/10' />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <p
        className='mt-1 text-[11px] italic text-slate-500 dark:text-slate-400'
        data-huddle-card='gone'
      >
        This huddle is no longer available.
      </p>
    )
  }
  const phase = schedulePhase(data)
  const live = phase === 'live' || phase === 'soon'
  const join = () => void huddleStore.join(data.room)
  const inIt =
    huddleStore.getSnapshot().room === data.room && huddleStore.getSnapshot().status === 'live'
  const shown = data.invitees.slice(0, 5)
  const more = data.invitees.length - shown.length
  const action =
    'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
  const secondary = cn(
    action,
    'border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-white/5'
  )
  return (
    <div className={shell} data-huddle-card={phase}>
      <div className='flex items-start gap-2'>
        <span
          className={cn(
            'mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md',
            phase === 'live'
              ? 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan'
              : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300'
          )}
          aria-hidden
        >
          {phase === 'live' ? (
            <Headphones className='h-4 w-4' strokeWidth={2} />
          ) : (
            <CalendarClock className='h-4 w-4' strokeWidth={2} />
          )}
        </span>
        <div className='min-w-0 flex-1'>
          <p
            className={cn(
              'line-clamp-2 break-words text-[12.5px] font-semibold',
              phase === 'cancelled' && 'line-through opacity-60'
            )}
          >
            {data.title}
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
            {formatScheduleWhen(data.starts_at, data.ends_at)}
          </p>
          <p className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
            {phase === 'cancelled'
              ? 'Cancelled'
              : phase === 'ended'
                ? 'Ended'
                : phase === 'live'
                  ? data.live
                    ? 'On now — people are talking'
                    : 'On now — nobody has joined yet'
                  : `Starts ${formatStartsIn(data.starts_at)} · ${data.organizer.name ?? 'Someone'} organised it`}
          </p>
        </div>
      </div>
      {data.invitees.length > 0 && (
        <div className='mt-2 flex items-center gap-1.5' data-huddle-card-invitees>
          <span className='flex -space-x-1.5'>
            {shown.map((p) => (
              <span
                key={p.id}
                className='rounded-full ring-2 ring-white dark:ring-card'
                style={{ lineHeight: 0 }}
                data-tip={p.name ?? undefined}
              >
                {renderAvatar(p.id, p.name)}
              </span>
            ))}
          </span>
          <span className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
            {shown.map((p) => p.name ?? 'Someone').join(', ')}
            {more > 0 && ` +${more}`}
          </span>
        </div>
      )}
      {phase !== 'cancelled' && phase !== 'ended' && (
        <div className='mt-2.5 flex flex-wrap items-center gap-1.5'>
          {live && !inIt && (
            <button
              type='button'
              onClick={join}
              className={cn(action, 'bg-nvr-cyan text-white hover:bg-[#00b8e0]')}
              data-huddle-card-join
            >
              <Headphones className='h-3.5 w-3.5' strokeWidth={2} />
              Join
            </button>
          )}
          {live && inIt && (
            <span className='inline-flex h-7 items-center gap-1 text-[11.5px] font-medium text-nvr-navy dark:text-nvr-cyan'>
              <Headphones className='h-3.5 w-3.5' strokeWidth={2} />
              You are in it
            </span>
          )}
          <button
            type='button'
            onClick={() => downloadIcs(data, roomUrl ?? null)}
            className={secondary}
            data-tip='Download a calendar file (.ics)'
            data-huddle-card-ics
          >
            <CalendarPlus className='h-3.5 w-3.5' strokeWidth={2} />
            Calendar
          </button>
          <a
            href={outlookComposeUrl(data, roomUrl ?? null)}
            target='_blank'
            rel='noopener noreferrer'
            className={secondary}
            data-tip='Open a pre-filled event in Outlook on the web'
            data-huddle-card-outlook
          >
            <ExternalLink className='h-3.5 w-3.5' strokeWidth={2} />
            Outlook
          </a>
          {data.can_cancel && (
            <span className='ml-auto'>
              {confirm ? (
                <span className='inline-flex items-center gap-1 text-[11px]'>
                  <span className='text-slate-500 dark:text-slate-400'>Cancel it?</span>
                  <button
                    type='button'
                    onClick={() => cancel.mutate()}
                    disabled={cancel.isPending}
                    className='h-6 rounded px-1.5 font-medium text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/15'
                    data-huddle-card-cancel-confirm
                  >
                    Yes
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirm(false)}
                    className='h-6 rounded px-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10'
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  type='button'
                  onClick={() => setConfirm(true)}
                  className='h-6 rounded px-1.5 text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
                  data-huddle-card-cancel
                >
                  Cancel huddle
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
