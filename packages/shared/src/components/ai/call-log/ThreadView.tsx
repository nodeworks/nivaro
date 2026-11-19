import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, ThumbsDown, ThumbsUp, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { QueryErrorState } from '../../QueryErrorState'
import { SheetTitle } from '../../ui/sheet'
import { Skeleton } from '../../ui/skeleton'
import { AiMarkdown } from '../AiMarkdown'
import { num, resultLabel, resultOf, secs, tok, usd, whenShort } from './format'
import { Fold } from './TranscriptView'
import type { Thread, ThreadTurn } from './types'

/**
 * The whole Ask AI conversation behind a call: every turn in order, each
 * answer with its model calls folded under it, thumbs and comments, cost per
 * turn and in total. The turn the open call belongs to is marked and scrolled
 * to; every call opens back in the call view. Opening it is logged.
 */

function FeedbackLine({ f }: { f: ThreadTurn['feedback'][number] }) {
  return (
    <li className='flex items-start gap-1.5 text-[11.5px]'>
      {f.rating > 0 ? (
        <ThumbsUp
          className='mt-0.5 h-3 w-3 text-green-700 dark:text-[#b9d3a6]'
          aria-label='Thumbs up'
        />
      ) : (
        <ThumbsDown
          className='mt-0.5 h-3 w-3 text-red-700 dark:text-[#eaa3a3]'
          aria-label='Thumbs down'
        />
      )}
      <span className='text-slate-600 dark:text-slate-300'>
        <span className='font-medium'>{f.user_name}</span>
        {f.comment ? ` — ${f.comment}` : ''}
      </span>
    </li>
  )
}

function TurnCard({
  turn,
  index,
  focused,
  currentCall,
  onOpenCall
}: {
  turn: ThreadTurn
  index: number
  focused: boolean
  currentCall: number | null
  onOpenCall: (id: number) => void
}) {
  const [callsOpen, setCallsOpen] = useState(focused)
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [focused])
  return (
    <li
      ref={ref}
      data-ai-thread-turn={index}
      className={cn(
        'scroll-mt-3 rounded-lg border bg-white dark:bg-card',
        focused
          ? 'border-nvr-cyan/60 ring-1 ring-nvr-cyan/30'
          : 'border-slate-200 dark:border-border'
      )}
    >
      <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500 dark:border-border/60 dark:text-muted-foreground'>
        <span className='font-semibold text-slate-700 dark:text-slate-200'>Turn {index}</span>
        {turn.asked_by && <span>{turn.asked_by}</span>}
        {turn.asked_at && <span>{whenShort(turn.asked_at)}</span>}
        {focused && (
          <span className='rounded-full bg-nvr-cyan/15 px-2 py-px font-medium text-slate-800 dark:text-foreground'>
            this call's turn
          </span>
        )}
        <span className='ml-auto tabular-nums'>
          {turn.calls.length > 0
            ? `${usd(turn.cost_usd)} · ${tok(turn.tokens)} tokens · ${secs(turn.latency_ms)}`
            : ''}
        </span>
      </div>
      <div className='flex flex-col gap-2.5 px-3 py-3'>
        {turn.question ? (
          <div className='rounded-lg bg-slate-100 px-3 py-2 text-[13px] leading-relaxed text-slate-900 dark:bg-muted dark:text-foreground'>
            <p className='whitespace-pre-wrap break-words'>{turn.question}</p>
          </div>
        ) : turn.withheld ? (
          <p className='text-[12px] italic text-slate-500'>This message was removed.</p>
        ) : null}
        {turn.trace.length > 0 && (
          <ul className='flex flex-wrap gap-1.5'>
            {turn.trace.map((t, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: trace in order
                key={i}
                className={cn(
                  'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-px text-[11px]',
                  t.error
                    ? 'border-red-200 bg-red-50 text-red-800 dark:border-[#e08383]/30 dark:bg-[#e08383]/10 dark:text-[#eaa3a3]'
                    : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-muted-foreground'
                )}
                data-tip={t.summary ?? undefined}
              >
                <Wrench className='h-3 w-3 shrink-0' aria-hidden />
                <span className='font-mono'>{t.tool}</span>
                {t.summary && <span className='truncate'>· {t.summary}</span>}
              </li>
            ))}
          </ul>
        )}
        {turn.answer != null ? (
          <AiMarkdown content={turn.answer} className='text-[13px]' />
        ) : turn.withheld ? (
          <p className='text-[12px] italic text-slate-500'>
            This answer was withheld (its author's access only).
          </p>
        ) : (
          <p className='text-[12px] italic text-slate-500'>No answer was stored.</p>
        )}
        {turn.feedback.length > 0 && (
          <ul className='flex flex-col gap-1'>
            {turn.feedback.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: feedback in order
              <FeedbackLine key={i} f={f} />
            ))}
          </ul>
        )}
        {turn.calls.length > 0 && (
          <div>
            <button
              type='button'
              onClick={() => setCallsOpen(!callsOpen)}
              aria-expanded={callsOpen}
              className='inline-flex items-center gap-1 rounded text-[11.5px] text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:text-foreground'
            >
              <ChevronRight
                className={cn(
                  'h-3 w-3 transition-transform duration-150 motion-reduce:transition-none',
                  callsOpen && 'rotate-90'
                )}
                aria-hidden
              />
              {turn.calls.length} model {turn.calls.length === 1 ? 'call' : 'calls'}
            </button>
            <Fold open={callsOpen}>
              <ul className='mt-1.5 divide-y divide-slate-100 rounded-md border border-slate-100 text-[11.5px] dark:divide-border/60 dark:border-border/60'>
                {turn.calls.map((c) => (
                  <li key={c.id}>
                    <button
                      type='button'
                      onClick={() => onOpenCall(c.id)}
                      className={cn(
                        'grid w-full grid-cols-[1fr_auto] items-center gap-x-3 px-2.5 py-1.5 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/40',
                        currentCall === c.id && 'bg-nvr-cyan/10'
                      )}
                    >
                      <span className='min-w-0 truncate'>
                        <span className='font-mono text-[11px]'>{c.model}</span>
                        <span className='text-slate-500 dark:text-muted-foreground'>
                          {' '}
                          · {resultLabel(resultOf(c))}
                          {c.tools.length ? ` · ${c.tools.join(', ')}` : ''}
                        </span>
                      </span>
                      <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                        {usd(c.cost_usd, 3)} · {secs(c.latency_ms)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Fold>
          </div>
        )}
      </div>
    </li>
  )
}

export function ThreadView({
  callId,
  onBack,
  onOpenCall
}: {
  callId: number
  onBack: () => void
  onOpenCall: (id: number) => void
}) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['nvr-ai-call-thread', callId],
    queryFn: () =>
      client.request<{ data: Thread }>(get('/ai/call-log/thread', { call: String(callId) }))
  })
  const t = q.data?.data
  const focusTurn =
    t?.turns.findIndex(
      (x) =>
        (t.focus_message_id && x.answer_id === t.focus_message_id) ||
        x.calls.some((c) => c.id === callId)
    ) ?? -1
  return (
    <div className='flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-right-6 duration-200 motion-reduce:animate-none'>
      <div className='shrink-0 border-b border-slate-200 px-5 pb-3 pt-4 pr-12 dark:border-border'>
        <button
          type='button'
          onClick={onBack}
          className='mb-1.5 inline-flex items-center gap-1 rounded text-[12px] text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:text-foreground'
        >
          <ArrowLeft className='h-3.5 w-3.5' aria-hidden /> Back to the call
        </button>
        <SheetTitle className='line-clamp-2 text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          {t?.conversation?.title || (t ? 'Conversation' : 'Loading the conversation…')}
        </SheetTitle>
        {t && (
          <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {t.conversation
              ? `${t.conversation.owner_name}'s conversation · `
              : 'Rebuilt from what the model was sent (no saved thread) · '}
            {num(t.totals.turns)} {t.totals.turns === 1 ? 'turn' : 'turns'} · {num(t.totals.calls)}{' '}
            model calls · {usd(t.totals.cost_usd)} · {tok(t.totals.tokens)} tokens ·{' '}
            {secs(t.totals.latency_ms)} in the model
          </p>
        )}
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-4 dark:bg-background sm:px-5'>
        {q.isLoading ? (
          <div className='flex flex-col gap-3'>
            <Skeleton className='h-24 w-full' />
            <Skeleton className='h-32 w-full' />
          </div>
        ) : q.isError ? (
          <QueryErrorState
            error={q.error}
            what='the conversation'
            onRetry={() => void q.refetch()}
          />
        ) : t?.turns.length ? (
          <ol className='flex flex-col gap-3'>
            {t.turns.map((turn, i) => (
              <TurnCard
                key={turn.question_id || turn.answer_id || i}
                turn={turn}
                index={i + 1}
                focused={i === focusTurn}
                currentCall={callId}
                onOpenCall={onOpenCall}
              />
            ))}
          </ol>
        ) : (
          <p className='text-[12.5px] text-slate-500'>This conversation has no turns left.</p>
        )}
        {t?.reconstructed && (
          <p className='mt-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            The person's Ask AI history was off for this question (or it came from the chat bot), so
            there is no saved thread: the earlier turns are what the model was sent with it.
          </p>
        )}
      </div>
    </div>
  )
}
