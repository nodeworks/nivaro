import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { formatRelative } from '../../lib/utils'
import type { ChatPoll } from './chat-core'

/**
 * A chat poll (#2337) under its question. Single choice votes on click;
 * several-answer polls toggle options then Submit. Counts arrive with the
 * message window, so a vote anywhere refreshes every open copy.
 */
export function PollCard({ poll, room, mine }: { poll: ChatPoll; room: string; mine?: boolean }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<number[] | null>(null)
  const picks = draft ?? poll.mine
  const total = Math.max(
    1,
    poll.options.reduce((n, o) => n + o.count, 0)
  )

  const vote = useMutation({
    mutationFn: (options: number[]) =>
      client.request(post(`/chat/polls/${poll.id}/vote`, { options })),
    onSuccess: () => {
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['nvr-chat', room] })
    },
    onError: (e) =>
      toast.error((e as { response?: { error?: string } })?.response?.error ?? 'Vote failed')
  })
  const close = useMutation({
    mutationFn: () => client.request(post(`/chat/polls/${poll.id}/close`, {})),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-chat', room] })
  })

  const click = (i: number) => {
    if (poll.closed) return
    if (!poll.multiple) return vote.mutate(picks.includes(i) ? [] : [i])
    setDraft(picks.includes(i) ? picks.filter((p) => p !== i) : [...picks, i].sort((a, b) => a - b))
  }

  return (
    <div
      className={cn(
        'mt-1.5 w-[280px] max-w-full space-y-1 rounded-lg border p-2 text-[12px]',
        mine
          ? 'border-white/30 bg-white/10'
          : 'border-slate-200 bg-white text-slate-800 dark:border-border dark:bg-card dark:text-slate-100'
      )}
      data-chat-poll={poll.id}
    >
      {poll.options.map((o) => {
        const on = picks.includes(o.index)
        const pct = Math.round((o.count / total) * 100)
        return (
          <button
            key={o.index}
            type='button'
            disabled={poll.closed || vote.isPending}
            onClick={() => click(o.index)}
            className={cn(
              'relative block w-full overflow-hidden rounded-md border px-2 py-1 text-left',
              on ? 'border-nvr-cyan' : 'border-slate-200 dark:border-border',
              !poll.closed && 'hover:border-nvr-cyan'
            )}
            data-chat-poll-option={o.index}
          >
            <span
              className='absolute inset-y-0 left-0 bg-nvr-cyan/15'
              style={{ width: `${pct}%` }}
              aria-hidden
            />
            <span className='relative flex items-center justify-between gap-2'>
              <span className='min-w-0 truncate'>
                {on ? '✓ ' : ''}
                {o.label}
              </span>
              <span className='shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
                {o.count}
              </span>
            </span>
            {o.voters && o.voters.length > 0 && (
              <span className='relative block truncate text-[10.5px] text-slate-500 dark:text-slate-400'>
                {o.voters.map((v) => v.name ?? 'Someone').join(', ')}
              </span>
            )}
          </button>
        )
      })}
      <div className='flex items-center justify-between gap-2 text-[10.5px] text-slate-500 dark:text-slate-400'>
        <span>
          {poll.total_voters} {poll.total_voters === 1 ? 'vote' : 'votes'}
          {poll.anonymous ? ' · anonymous' : ''}
          {poll.multiple ? ' · several answers' : ''}
          {poll.closed
            ? ' · closed'
            : poll.closes_at
              ? ` · closes ${formatRelative(poll.closes_at)}`
              : ''}
        </span>
        <span className='flex items-center gap-2'>
          {draft && !poll.closed && (
            <button
              type='button'
              onClick={() => vote.mutate(draft)}
              disabled={vote.isPending}
              className='font-medium text-nvr-cyan'
              data-chat-poll-submit
            >
              Submit
            </button>
          )}
          {poll.can_close && !poll.closed && (
            <button
              type='button'
              onClick={() => close.mutate()}
              className='hover:text-slate-800 dark:hover:text-slate-100'
            >
              Close
            </button>
          )}
        </span>
      </div>
    </div>
  )
}
