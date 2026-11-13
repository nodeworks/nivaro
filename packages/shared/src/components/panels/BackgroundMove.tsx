import { AlertTriangle, Loader2 } from 'lucide-react'
import { type CSSProperties, useEffect, useMemo, useRef } from 'react'
import { useItemEditAuth } from '../../context'
import { describeError } from '../../lib/error-message'
import { isRawErrorText } from '../../lib/safe-error'
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
  const reason = (problem.reason ?? '').trim()
  const label = (problem.transition_label ?? '').trim()
  const rest =
    label && reason.toLowerCase().startsWith(`${label.toLowerCase()}:`)
      ? reason.slice(label.length + 1).trim()
      : reason
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : ''
}

/** The status line a partner call's failure is stored with: "… — HTTP 400: <body excerpt>". */
const STATUS_MARK = /\bHTTP \d{3}: /
/** Where a partner's answer keeps its sentence, most telling first. */
const WORD_KEYS = [
  'message',
  'error_description',
  'detail',
  'error',
  'title',
  'reason',
  'description',
  'msg'
]
const KEYED_SENTENCE = new RegExp(`"(?:${WORD_KEYS.join('|')})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`)

/** A JSON string's inner text as the text it stands for (a body cut short may end mid-escape). */
function unescapeJson(inner: string): string {
  try {
    return JSON.parse(`"${inner.replace(/\\$/, '')}"`) as string
  } catch {
    return inner
  }
}

function sentenceIn(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return null
  const body = value as Record<string, unknown>
  for (const key of WORD_KEYS) {
    const found = sentenceIn(body[key], depth + 1)
    if (found?.trim()) return found
  }
  return null
}

/**
 * What the other system answered, in its own words, when a stored reason is a
 * partner call's failure ("Submission failed — HTTP 400: "The project is not
 * valid""). Those words are what the person needs to put the request right, so
 * the row shows them: "Submission failed: The project is not valid". Only words:
 * the status line itself is never shown, and an answer that reads as anything
 * else (markup, a stack, SQL, an id) gives null, so the reason is read the usual
 * way. The body is an excerpt and may be cut short.
 */
export function partnerWords(reason: string): string | null {
  const mark = STATUS_MARK.exec(reason)
  if (!mark) return null
  const body = reason.slice(mark.index + mark[0].length).trim()
  let words: string | null = null
  // The sentence did not end where it stops: the stored body was cut inside it.
  let cut = false
  try {
    words = sentenceIn(JSON.parse(body))
  } catch {
    // Cut short: the sentence under a known key, else a body that is one (unfinished) string.
    const keyed = KEYED_SENTENCE.exec(body)
    if (keyed) {
      words = unescapeJson(keyed[1])
      cut = body[keyed.index + keyed[0].length] !== '"'
    } else if (body.startsWith('"')) {
      words = unescapeJson(body.slice(1).replace(/"$/, ''))
      cut = body.length < 2 || !body.endsWith('"')
    }
  }
  const full = (words ?? '').replace(/\s+/g, ' ').trim()
  // A cut sentence says so: it must never just stop mid-word as if that were all of it.
  const said = cut || full.length > 300 ? `${full.slice(0, 299).trimEnd()}…` : full
  // Judged on the sentence itself, before the mark: "Bad Request…" is still a status phrase.
  if (full.length < 3 || /<[a-z!/]/i.test(full) || isRawErrorText(full)) return null
  const lead = reason
    .slice(0, mark.index)
    .replace(/[\s:·—–-]+$/, '')
    .trim()
  return lead ? `${lead}: ${said}` : said
}

/** The other system's status anywhere in a stored reason: "… — HTTP 502: …", "… (HTTP 401): …". */
const PARTNER_STATUS = /\bHTTP (\d{3})\b/
/** A call that got no answer at all, in Node's and the API's own words. */
const NO_ANSWER =
  /\b(?:fetch failed|Timed out after \d+ms|socket hang up|E(?:CONN[A-Z]+|NOTFOUND|AI_AGAIN|TIMEDOUT|HOSTUNREACH))\b/

/**
 * What a partner call's failure means when its answer held no words a person can
 * read. Said about the other system: the sentences every other error is read with
 * are about the person's own request ("You've been signed out", "Someone else
 * changed this"), and here the status is the other system's answer to this app.
 * Null for a reason that is not a partner call's failure.
 */
export function partnerOutcome(reason: string): string | null {
  const status = Number(PARTNER_STATUS.exec(reason)?.[1] ?? 0)
  if (!status) {
    if (!NO_ANSWER.test(reason)) return null
    return /Timed out after|ETIMEDOUT/.test(reason)
      ? 'The other system took too long to answer.'
      : 'The other system could not be reached.'
  }
  if (status === 401 || status === 403)
    return 'The other system did not accept this app’s sign-in. An administrator needs to check the connection.'
  if (status === 408 || status === 504) return 'The other system took too long to answer.'
  if (status === 502 || status === 503) return 'The other system is not answering right now.'
  if (status >= 500) return 'The other system ran into a problem of its own.'
  return 'The other system refused the request.'
}

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
  // A partner's own answer shows in its words, or failing that as what it means about the
  // other system; anything else is read like every other error.
  const words = useMemo(
    () =>
      (reason ? (partnerWords(reason) ?? partnerOutcome(reason)) : null) ??
      said?.title.trim() ??
      '',
    [reason, said]
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
            className='mt-0.5 line-clamp-3 break-words text-[12px] leading-snug text-slate-700 dark:text-slate-300'
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
