import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  Clock,
  CloudOff,
  Loader2,
  PauseCircle,
  RefreshCw,
  Send,
  XCircle
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { LIVE_ASPECTS, useLiveRecordQueries } from '../../lib/live'
import { useLiveFade } from '../../lib/live-screen'
import {
  msUntilNoAnswer,
  msUntilRetryTick,
  retryCountdown,
  type SendStatusFact,
  type SendStatusWords,
  sendStatusWords
} from '../../lib/send-status'
import { cn } from '../../lib/utils'

/**
 * Where the record's latest send to each partner stands (rt4 #10), on the record's
 * pipeline row and on the list row. Words: lib/send-status.ts. Facts: GET
 * /erp-submissions/send-status (only records the viewer can see answer).
 *
 * Live: every change to a send announces the record's `$integrations` aspect, so the
 * row re-reads on its own; a send that stops answering turns into "No answer" at its
 * own deadline with no write, so a timer re-draws it then. A failed send a sweep will try
 * again (rt6 #18) counts down to its retry, re-drawn once a minute while one is coming.
 */

export const SEND_STATUS_KEY = 'send-status'

/**
 * One shape per state, so a mark reads without its tooltip and never borrows the app's
 * generic warning triangle: in flight (spinner), with the partner (clock), retrying by
 * itself (circling arrows), accepted (tick), refused (cross), not reached (cloud off),
 * held without an answer (pause).
 */
function iconFor(w: SendStatusWords): { Icon: typeof Loader2; cls: string; label: string } {
  const sky = 'text-sky-600 dark:text-sky-400'
  const amber = 'text-amber-600 dark:text-amber-400'
  // Amber, like the partner's dot in the header chip: one colour for "retrying" everywhere.
  if (w.retry_at) return { Icon: RefreshCw, cls: amber, label: 'Retrying' }
  switch (w.state) {
    case 'sending':
      return {
        Icon: Loader2,
        cls: `${sky} animate-spin motion-reduce:animate-none`,
        label: 'Sending'
      }
    case 'waiting':
      return { Icon: Clock, cls: sky, label: 'Waiting' }
    case 'accepted':
      return {
        Icon: CheckCircle2,
        cls: 'text-emerald-600 dark:text-emerald-400',
        label: 'Accepted'
      }
    case 'refused':
      return { Icon: XCircle, cls: 'text-rose-600 dark:text-rose-400', label: 'Refused' }
    case 'not_taken':
      return { Icon: CloudOff, cls: amber, label: 'Not sent' }
    default:
      return { Icon: PauseCircle, cls: amber, label: 'No answer' }
  }
}

/** Re-draw when the soonest in-flight send passes its deadline, or a retry countdown moves. */
function useDeadlineTick(facts: SendStatusFact[] | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    // Each tick re-arms for the next moment something on screen changes (a deadline, a minute).
    const arm = () => {
      const at = Date.now()
      const waits = (Array.isArray(facts) ? facts : [])
        .flatMap((f) => [msUntilNoAnswer(f, at), msUntilRetryTick(f, at)])
        .filter((n): n is number => n != null)
      if (waits.length === 0) return
      t = setTimeout(
        () => {
          setNow(Date.now())
          arm()
        },
        Math.min(...waits)
      )
    }
    arm()
    return () => {
      if (t) clearTimeout(t)
    }
  }, [facts])
  return now
}

/** The hover / screen-reader sentence: the line, then why it will not be retried. */
function fullSentence(w: SendStatusWords, now: number): string {
  const left = retryCountdown(w.retry_at, now)
  return [w.text + (left ? ` · ${left}` : ''), w.detail].filter(Boolean).join(' · ')
}

/** The arm for useLiveFade: the time of a background re-read, never the first load. */
function useRefreshArm(dataUpdatedAt: number): number {
  const first = useRef<number | null>(null)
  if (first.current == null && dataUpdatedAt) first.current = dataUpdatedAt
  return dataUpdatedAt && dataUpdatedAt !== first.current ? dataUpdatedAt : 0
}

/** One record's send facts — one cache entry shared by the pipeline row and the header chip. */
export function useRecordSendStatus(collection: string, item: string | number) {
  const client = useNivaroClient()
  const id = String(item)
  return useQuery<SendStatusFact[]>({
    queryKey: [SEND_STATUS_KEY, collection, id],
    queryFn: () =>
      client
        .request<{ data: Record<string, SendStatusFact[]> }>(
          get('/erp-submissions/send-status', { collection, ids: id })
        )
        .then((r) => {
          const v = r?.data?.[id]
          return Array.isArray(v) ? v : []
        }),
    enabled: !!collection && !!id && id !== 'new',
    staleTime: 30_000,
    retry: false
  })
}

/** One sentence per partner, under the record's pipeline row. Nothing when there is no send. */
export function SendStatusLines({
  collection,
  item,
  skipIds,
  className
}: {
  collection: string
  item: string | number
  /** Sends another row already speaks for (the move row's unanswered send). */
  skipIds?: number[]
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const id = String(item)
  const key = useMemo(() => [SEND_STATUS_KEY, collection, id], [collection, id])
  const { data, dataUpdatedAt } = useRecordSendStatus(collection, id)
  useLiveRecordQueries(collection, id, [key], {
    aspects: [LIVE_ASPECTS.integrations],
    client: qc,
    debounceMs: 800
  })
  const now = useDeadlineTick(data)
  const fadeRef = useLiveFade(useRefreshArm(dataUpdatedAt))
  // Send again: the same stored request, through the record's own retry route (it checks
  // the person may update the record). The row re-reads live from `$integrations`.
  const resend = useMutation({
    mutationFn: (submissionId: number) =>
      client.request(post(`/erp-submissions/${submissionId}/retry`, {})),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (err) => toastError(err, 'Could not send it again')
  })
  const skip = new Set(skipIds ?? [])
  const shown = (Array.isArray(data) ? data : []).filter((f) => !skip.has(f.id))
  if (shown.length === 0) return null
  return (
    <div
      ref={fadeRef}
      data-send-status
      className={cn(
        'space-y-1 border-t border-slate-100 px-4 py-2 dark:border-border/60',
        className
      )}
    >
      {shown.map((f) => {
        const w = sendStatusWords(f, { now })
        const { Icon, cls } = iconFor(w)
        const left = retryCountdown(w.retry_at, now)
        const sendingThis = resend.isPending && resend.variables === f.id
        return (
          <div
            key={f.id}
            data-send-state={w.state}
            className='flex items-start gap-2 text-[12px] leading-snug text-slate-700 dark:text-slate-300'
          >
            <Icon aria-hidden className={cn('mt-[2px] h-3.5 w-3.5 shrink-0', cls)} />
            <div className='min-w-0 flex-1'>
              <p className='break-words'>
                {w.text}
                {left && (
                  // rt6 #18 — the countdown to the automatic retry, quiet beside the sentence.
                  <span
                    data-send-retry-countdown
                    className='ml-1.5 whitespace-nowrap text-[11px] tabular-nums text-slate-500 dark:text-slate-400'
                  >
                    · {left}
                  </span>
                )}
              </p>
              {w.detail && (
                <p
                  data-send-no-retry
                  className='mt-0.5 break-words text-[11px] text-slate-500 dark:text-slate-400'
                >
                  {w.detail}
                </p>
              )}
            </div>
            {w.resend && (
              <button
                type='button'
                data-send-again={f.id}
                disabled={resend.isPending}
                onClick={() => resend.mutate(f.id)}
                className='inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:opacity-60 dark:border-border dark:bg-transparent dark:text-slate-200 dark:hover:bg-white/5'
              >
                {sendingThis ? (
                  <Loader2
                    aria-hidden
                    className='h-3 w-3 animate-spin motion-reduce:animate-none'
                  />
                ) : (
                  <Send aria-hidden className='h-3 w-3' />
                )}
                {sendingThis ? 'Sending…' : 'Send again'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The list row's mark: one small icon per partner, the sentence on hover. Purely
 * presentational — the list reads the facts once per page.
 */
export function SendStatusMarks({
  facts,
  className
}: {
  facts: SendStatusFact[] | undefined
  className?: string
}) {
  const now = useDeadlineTick(Array.isArray(facts) ? facts : undefined)
  if (!Array.isArray(facts) || facts.length === 0) return null
  return (
    <span
      data-send-status-marks
      className={cn('inline-flex shrink-0 items-center gap-1', className)}
    >
      {facts.map((f) => {
        const w = sendStatusWords(f, { now })
        const { Icon, cls, label } = iconFor(w)
        const sentence = fullSentence(w, now)
        return (
          <span
            key={f.id}
            data-send-state={w.state}
            data-tip={sentence}
            aria-label={`${f.api}: ${label}. ${sentence}`}
            role='img'
            className='inline-flex shrink-0'
          >
            <Icon aria-hidden className={cn('h-3.5 w-3.5', cls)} />
          </span>
        )
      })}
    </span>
  )
}
