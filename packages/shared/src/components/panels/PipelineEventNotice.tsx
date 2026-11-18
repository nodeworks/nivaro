import { AlertTriangle, Plug } from 'lucide-react'
import { useContext, useMemo } from 'react'
import { useItemEditAuth } from '../../context'
import type { ErrorDescription } from '../../lib/error-message'
import { cn } from '../../lib/utils'
import { ErrorDetails } from '../ErrorNotice'
import { useOverflowTip } from '../TipLayer'
import { Button } from '../ui/button'
import { MoveProblemWordsContext, problemReason, startedBy } from './BackgroundMove'
import { type PipelineEvent, pipelineEventWords } from './pipeline-notices'

/**
 * One failed automatic push (or move) said once (pipeline-notices.ts): what did not go
 * through, the other system's reason quoted once, what to do, and the actions that do it.
 * Amber: a person needs to act. Everything a support person needs (the stored answer, its
 * status, the run / send / transition ids) is folded into "Details for support".
 */
export function PipelineEventNotice({
  event,
  onRetry,
  retryDisabled,
  onOpenIntegrations,
  canMoveByHand,
  className
}: {
  event: PipelineEvent
  /** Runs the same move again, as its own button would. Absent = not on offer to this person. */
  onRetry?: () => void
  retryDisabled?: boolean
  /** Opens the record's Integrations dialog. Absent = no Integrations chip on this page. */
  onOpenIntegrations?: () => void
  /** Other moves are on offer to this person, by hand. */
  canMoveByHand?: boolean
  className?: string
}) {
  const { userId } = useItemEditAuth()
  const hostWords = useContext(MoveProblemWordsContext)
  const fromHost = useMemo(() => {
    const p = event.problem
    const reason = p ? problemReason(p) : ''
    return reason ? hostWords?.(reason)?.trim() || null : null
  }, [event.problem, hostWords])
  const words = pipelineEventWords(event, {
    startedBy: event.problem ? startedBy(event.problem, userId) : null,
    hostWords: fromHost,
    canRetry: !!onRetry,
    canOpenIntegrations: !!onOpenIntegrations,
    canMoveByHand
  })
  const reasonRef = useOverflowTip<HTMLParagraphElement>(words.reason)
  const description: ErrorDescription = {
    title: `${words.label} ${words.headline}`,
    status: words.status ?? undefined,
    code: words.errorClass ? words.errorClass.toUpperCase() : undefined,
    technical: [words.raw, ...words.ids.map((r) => `${r.label}: ${r.value}`)]
      .filter(Boolean)
      .join('\n')
  }
  const rows = [...(words.raw ? [{ label: 'Stored answer', value: words.raw }] : []), ...words.ids]
  const hasActions = !!onRetry || !!onOpenIntegrations
  return (
    <div
      role='note'
      data-pipeline-event=''
      data-move-problem={event.problem?.result}
      data-pipeline-auto-held={event.held ? '' : undefined}
      data-send-spoken={event.send?.id}
      className={cn(
        'flex items-start gap-2.5 border-t border-amber-200/80 bg-amber-50/70 px-4 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/[0.06]',
        className
      )}
    >
      <AlertTriangle
        aria-hidden
        className='mt-[3px] h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
      />
      <div className='min-w-0 flex-1'>
        <p className='break-words text-[13px] leading-snug text-slate-800 dark:text-slate-100'>
          <span className='font-medium'>{words.label}</span> {words.headline}
        </p>
        {words.reason && (
          <p
            ref={reasonRef}
            data-pipeline-event-reason
            className={cn(
              'mt-0.5 break-words text-[12px] leading-snug text-slate-700 dark:text-slate-300',
              words.reasonFromHost ? 'whitespace-pre-line' : 'line-clamp-3'
            )}
          >
            {words.reason}
          </p>
        )}
        {words.next && (
          <p
            data-pipeline-event-next
            className='mt-1 break-words text-[12px] leading-snug text-amber-900 dark:text-amber-200'
          >
            {words.next}
          </p>
        )}
        {hasActions && (
          <div className='mt-2 flex flex-wrap items-center gap-1.5'>
            {onRetry && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                disabled={retryDisabled}
                onClick={onRetry}
                data-move-problem-retry
              >
                Try again
              </Button>
            )}
            {onOpenIntegrations && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='h-7 gap-1.5 text-[12px]'
                onClick={onOpenIntegrations}
                data-pipeline-event-integrations
              >
                <Plug aria-hidden className='h-3 w-3' />
                Open Integrations
              </Button>
            )}
          </div>
        )}
        {words.meta && (
          <p className='mt-1.5 text-[11.5px] text-amber-800/80 dark:text-amber-300/80'>
            {words.meta}
          </p>
        )}
        <ErrorDetails description={description} action={words.label} rows={rows} className='mt-1' />
      </div>
    </div>
  )
}
