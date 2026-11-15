import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Clock, Loader2, PauseCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { LIVE_ASPECTS, useLiveRecordQueries } from '../../lib/live'
import { useLiveFade } from '../../lib/live-screen'
import {
  msUntilNoAnswer,
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
 * own deadline with no write, so a timer re-draws it then.
 */

export const SEND_STATUS_KEY = 'send-status'

const TONE_ICON: Record<SendStatusWords['tone'], typeof Loader2> = {
  busy: Loader2,
  waiting: Clock,
  ok: CheckCircle2,
  problem: AlertTriangle,
  held: PauseCircle
}

const TONE_ICON_CLASS: Record<SendStatusWords['tone'], string> = {
  busy: 'text-sky-600 dark:text-sky-400 animate-spin motion-reduce:animate-none',
  waiting: 'text-sky-600 dark:text-sky-400',
  ok: 'text-emerald-600 dark:text-emerald-400',
  problem: 'text-amber-600 dark:text-amber-400',
  held: 'text-amber-600 dark:text-amber-400'
}

/** Re-draw once when the soonest in-flight send passes its deadline. */
function useDeadlineTick(facts: SendStatusFact[] | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const waits = (Array.isArray(facts) ? facts : [])
      .map((f) => msUntilNoAnswer(f))
      .filter((n): n is number => n != null)
    if (waits.length === 0) return
    const t = setTimeout(() => setNow(Date.now()), Math.min(...waits))
    return () => clearTimeout(t)
  }, [facts])
  return now
}

/** The arm for useLiveFade: the time of a background re-read, never the first load. */
function useRefreshArm(dataUpdatedAt: number): number {
  const first = useRef<number | null>(null)
  if (first.current == null && dataUpdatedAt) first.current = dataUpdatedAt
  return dataUpdatedAt && dataUpdatedAt !== first.current ? dataUpdatedAt : 0
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
  const { data, dataUpdatedAt } = useQuery<SendStatusFact[]>({
    queryKey: key,
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
  useLiveRecordQueries(collection, id, [key], {
    aspects: [LIVE_ASPECTS.integrations],
    client: qc,
    debounceMs: 800
  })
  const now = useDeadlineTick(data)
  const fadeRef = useLiveFade(useRefreshArm(dataUpdatedAt))
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
        const Icon = TONE_ICON[w.tone]
        return (
          <p
            key={f.id}
            data-send-state={w.state}
            className='flex items-start gap-2 text-[12px] leading-snug text-slate-700 dark:text-slate-300'
          >
            <Icon
              aria-hidden
              className={cn('mt-[2px] h-3.5 w-3.5 shrink-0', TONE_ICON_CLASS[w.tone])}
            />
            <span className='min-w-0 break-words'>{w.text}</span>
          </p>
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
    <span data-send-status-marks className={cn('inline-flex items-center gap-1', className)}>
      {facts.map((f) => {
        const w = sendStatusWords(f, { now })
        const Icon = TONE_ICON[w.tone]
        return (
          <span
            key={f.id}
            data-send-state={w.state}
            data-tip={w.text}
            aria-label={w.text}
            role='img'
            className='inline-flex'
          >
            <Icon aria-hidden className={cn('h-3.5 w-3.5', TONE_ICON_CLASS[w.tone])} />
          </span>
        )
      })}
    </span>
  )
}
