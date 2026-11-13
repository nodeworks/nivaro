import { AlertTriangle, Loader2 } from 'lucide-react'
import { type CSSProperties, createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { useItemEditAuth } from '../../context'
import { describeError } from '../../lib/error-message'
import {
  partnerOutcome,
  partnerSaid,
  partnerWords,
  withoutMoveLabel
} from '../../lib/partner-failure'
import { cn, formatRelative } from '../../lib/utils'
import { ErrorDetails } from '../ErrorNotice'
import { useOverflowTip } from '../TipLayer'
import { Button } from '../ui/button'

/**
 * Moves that run in the background (api services/transition-runs.ts).
 *
 * A transition marked that way is asked for with `accept_pending`; the server
 * then answers 202 as soon as its checks have passed and finishes the move
 * (the partner call, then the state change) on its own. While it runs, the
 * record's pipeline read carries `running_move` for everyone who has the
 * record open; a run that did not move the record leaves `last_move_problem`
 * until the record moves on. This file is what the two pipeline surfaces (the
 * Progress panel and the header buttons) share for it.
 */

export interface RunningMove {
  id: number
  transition_id: string | null
  transition_label: string | null
  started_at: string
  started_by: string | null
  started_by_name: string | null
  /** `background`: its starter did not wait. `inline`: someone is waiting on it. `auto`: a rule started it. */
  mode: 'background' | 'inline' | 'auto'
}

export interface MoveProblem extends RunningMove {
  /** `refused`: a check or the partner said no, nothing moved. `interrupted`: it
   *  stopped before it finished. `failed`: something on the server went wrong. */
  result: 'refused' | 'interrupted' | 'failed'
  reason: string | null
  finished_at: string | null
}

/** How often an open record asks again while a move is running on it. */
export const RUNNING_MOVE_POLL_MS = 4000

/**
 * The pipeline read's refetch interval: only while a move is running on the
 * record. The live event that ends it can be missed (it reads as this person's
 * own write for a few seconds after they pressed), so the page asks.
 */
export function runningMovePoll(
  data: { running_move?: RunningMove | null } | null | undefined
): number | false {
  return data?.running_move ? RUNNING_MOVE_POLL_MS : false
}

/**
 * Call `onEnded` when a move that was running on the record is no longer:
 * what it wrote (an order number, who owns the next step, the partner's
 * answer) landed after the press was answered, so the page reads it now.
 */
export function useRunEnded(running: boolean, onEnded: () => void): void {
  const was = useRef(false)
  const ended = useRef(onEnded)
  ended.current = onEnded
  useEffect(() => {
    if (was.current && !running) ended.current()
    was.current = running
  }, [running])
}

/** What a move's request adds when the move is marked to run in the background. */
export function pendingOptIn(
  transitions: Array<{ id: string; background?: boolean }> | null | undefined,
  transitionId: string
): { accept_pending?: true } {
  return (transitions ?? []).some((t) => t.id === transitionId && t.background === true)
    ? { accept_pending: true }
    : {}
}

/** The run a 202 answer names, or null when the move was made while the caller waited. */
export function startedInBackground(answer: unknown): RunningMove | null {
  const data = (answer as { data?: { background?: unknown; run?: RunningMove | null } } | null)
    ?.data
  return data?.background === true && data.run ? data.run : null
}

/** Ids compare whatever their case (the database hands uuids back upper-cased). */
export function sameMoveId(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toUpperCase() === b.toUpperCase()
}

/** "Started by Kim Lee" / "You started it" / "Started automatically". */
export function startedBy(run: RunningMove, viewerId?: string | null): string {
  if (run.mode === 'auto') return 'Started automatically'
  if (sameMoveId(run.started_by, viewerId)) return 'You started it'
  return run.started_by_name ? `Started by ${run.started_by_name}` : 'Started'
}

/** The reason without the move's own name in front of it ("Submit: submission failed — …"). */
export function problemReason(problem: Pick<MoveProblem, 'reason' | 'transition_label'>): string {
  return withoutMoveLabel(problem.reason, problem.transition_label)
}

// The reading of a partner call's failure lives in lib/partner-failure.ts (the toast of a
// move pressed the ordinary way uses it too); importers of this module keep finding it here.
export { partnerOutcome, partnerWords }

const rowBase = 'flex items-start gap-2.5'

/** What follows a running move's name, on its row and in the tip of the buttons it holds. */
const RUNNING_SENTENCE = 'is running. Other moves wait until it finishes.'
const runningLabel = (run: Pick<RunningMove, 'transition_label'>) =>
  run.transition_label?.trim() || 'A move'

/**
 * Why every move is held, in one line: the tip for buttons that are disabled
 * while a move runs (a disabled button cannot say so itself).
 */
export function runningMoveTip(run: Pick<RunningMove, 'transition_label'>): string {
  return `${runningLabel(run)} ${RUNNING_SENTENCE}`
}

/** What follows the move's name. Only a refusal is known to have moved nothing;
 *  the reason under it says the rest. */
const PROBLEM_SENTENCE: Record<MoveProblem['result'], string> = {
  refused: 'did not go through. The record was not moved.',
  interrupted: 'stopped before it finished.',
  failed: 'ran into a problem.'
}

/**
 * "Submit is running": the record's pipeline row for a move that has not ended
 * yet. `floating` is the header's variant, which has no row to sit in.
 */
export function RunningMoveNotice({
  run,
  floating,
  className,
  style
}: {
  run: RunningMove
  floating?: boolean
  className?: string
  style?: CSSProperties
}) {
  const { userId } = useItemEditAuth()
  const label = runningLabel(run)
  return (
    <div
      role='status'
      data-running-move={run.transition_id ?? ''}
      className={cn(
        rowBase,
        floating
          ? 'rounded-lg border border-sky-200 bg-sky-50 p-3 shadow-lg dark:border-sky-500/30 dark:bg-sky-950'
          : 'border-t border-sky-200/80 bg-sky-50/70 px-4 py-2.5 dark:border-sky-500/20 dark:bg-sky-500/[0.06]',
        className
      )}
      style={style}
    >
      <Loader2
        aria-hidden
        className='mt-[3px] h-3.5 w-3.5 shrink-0 animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400'
      />
      <div className='min-w-0 flex-1'>
        <p className='break-words text-[13px] leading-snug text-slate-800 dark:text-slate-100'>
          <span className='font-medium'>{label}</span> {RUNNING_SENTENCE}
        </p>
        <p className='mt-0.5 text-[11.5px] text-sky-800/80 dark:text-sky-300/80'>
          {startedBy(run, userId)} · {formatRelative(run.started_at)} · this page updates on its own
        </p>
      </div>
    </div>
  )
}

/**
 * A host's own reading of a stored refusal it knows (EFP: a warehouse's "InstallAddressLocationCode
 * field is required" → "The install location has no Oracle location code…"): what the row
 * shows instead of the other system's words, whole, one line per "\n". Null = not one it
 * knows; the row reads it as usual. The text as stored stays under "Details for support".
 */
export const MoveProblemWordsContext = createContext<((reason: string) => string | null) | null>(
  null
)

/**
 * The last run that did not move the record: what was said, and the move
 * again for someone who may make it. Shown until the record moves on.
 *
 * The stored reason is the refusal's own text (a check's words, a partner's
 * answer). It is read the way every other error is (describeError): plain words
 * show as they are; a status line, SQL or a stack is never shown, what it means
 * is, and the text itself stays in the folded "Details for support". The one
 * addition: what a partner answered shows in its own words (partnerWords).
 */
export function MoveProblemNotice({
  problem,
  onRetry,
  retryDisabled,
  className
}: {
  problem: MoveProblem
  /** Runs the same move again, as its own button would. Absent = not on offer to this person. */
  onRetry?: () => void
  retryDisabled?: boolean
  className?: string
}) {
  const { userId } = useItemEditAuth()
  const label = problem.transition_label?.trim() || 'The move'
  const reason = problemReason(problem)
  const said = useMemo(() => (reason ? describeError({ message: reason }, '') : null), [reason])
  const hostWords = useContext(MoveProblemWordsContext)
  // The host's reading of a refusal it knows first; then a partner's own answer in its
  // words, or failing that what it means about the other system; anything else is read like
  // every other error.
  const fromHost = useMemo(
    () => (reason ? hostWords?.(reason)?.trim() || null : null),
    [reason, hostWords]
  )
  const words = useMemo(
    () => fromHost ?? (reason ? partnerSaid(reason) : null) ?? said?.title.trim() ?? '',
    [fromHost, reason, said]
  )
  // The full words on hover only while the three lines cut them.
  const wordsRef = useOverflowTip<HTMLParagraphElement>(words)
  return (
    <div
      role='note'
      data-move-problem={problem.result}
      className={cn(
        rowBase,
        'border-t border-amber-200/80 bg-amber-50/70 px-4 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/[0.06]',
        className
      )}
    >
      <AlertTriangle
        aria-hidden
        className='mt-[3px] h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
      />
      <div className='min-w-0 flex-1'>
        <p className='break-words text-[13px] leading-snug text-slate-800 dark:text-slate-100'>
          <span className='font-medium'>{label}</span> {PROBLEM_SENTENCE[problem.result]}
        </p>
        {words && (
          <p
            ref={wordsRef}
            data-move-problem-reason
            className={cn(
              'mt-0.5 break-words text-[12px] leading-snug text-slate-700 dark:text-slate-300',
              // A host's words are short and curated (one per line): shown whole. The other
              // system's words can run long: three lines, the rest on hover.
              fromHost ? 'whitespace-pre-line' : 'line-clamp-3'
            )}
          >
            {words}
          </p>
        )}
        <p className='mt-0.5 text-[11.5px] text-amber-800/80 dark:text-amber-300/80'>
          {startedBy(problem, userId)} · {formatRelative(problem.finished_at ?? problem.started_at)}
        </p>
        {said && <ErrorDetails description={said} action={label} className='mt-1' />}
      </div>
      {onRetry && (
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='h-7 shrink-0 text-[12px]'
          disabled={retryDisabled}
          onClick={onRetry}
          data-move-problem-retry
        >
          Try again
        </Button>
      )}
    </div>
  )
}
