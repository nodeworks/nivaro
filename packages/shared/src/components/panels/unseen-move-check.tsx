import { useQueryClient } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { filterUnseen, SeenLog, type UnseenChange } from '../../lib/unseen-changes'
import { formatRelative } from '../../lib/utils'

/**
 * rt3 #14 — before a move, did someone else change this record in a way this page has not
 * shown? `check()` answers the list (empty = go on as before, no extra step); `review()`
 * closes nothing itself — the panel closes its confirm — and re-reads the record's surfaces so
 * the changes land on screen.
 *
 * The check never blocks a move: a slow or failed read answers "nothing unseen".
 */

/** How long a move press waits for the answer before it goes on without it. */
export const UNSEEN_CHECK_MS = 1500

interface UnseenAnswer {
  since: string
  changes: UnseenChange[]
  more: number
}

export function useUnseenMoveCheck(collection: string, item: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const logRef = useRef<SeenLog | null>(null)

  useEffect(() => {
    const log = new SeenLog(collection, String(item))
    logRef.current = log
    const cache = qc.getQueryCache()
    log.seed(
      cache
        .getAll()
        .filter((q) => q.state.status === 'success')
        .map((q) => ({ queryKey: q.queryKey, dataUpdatedAt: q.state.dataUpdatedAt }))
    )
    return cache.subscribe((event) => {
      if (event.type !== 'updated') return
      const action = event.action as { type?: string }
      if (action.type === 'fetch') log.started(event.query.queryHash)
      else if (action.type === 'success') log.succeeded(event.query.queryHash, event.query.queryKey)
    })
  }, [qc, collection, item])

  const check = useCallback(async (): Promise<UnseenChange[]> => {
    const log = logRef.current
    const since = log?.since()
    if (!log || since == null) return []
    const fieldsSince = log.fieldsSince()
    try {
      const answer = await Promise.race([
        client
          .request<{ data: UnseenAnswer }>(
            get(`/records/${collection}/${encodeURIComponent(String(item))}/unseen`, {
              since: new Date(since).toISOString(),
              ...(fieldsSince != null ? { fields_since: new Date(fieldsSince).toISOString() } : {})
            })
          )
          .then((r) => r.data),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), UNSEEN_CHECK_MS))
      ])
      if (!answer) return []
      return filterUnseen(answer.changes ?? [], log.all())
    } catch {
      return []
    }
  }, [client, collection, item])

  /** Bring the changes on screen: re-read the record, its lines and its files. */
  const review = useCallback(() => {
    const id = String(item)
    void qc.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey
        if (!Array.isArray(k)) return false
        if ((k[0] === 'item' || k[0] === 'rrv-record') && k[1] === collection)
          return String(k[2]) === id
        if (k[0] === 'item-heading-links' && k[1] === collection) return String(k[2]) === id
        if (k[0] === 'o2m-rows' || k[0] === 'm2m-items') return String(k[3]) === id
        return k[0] === 'files-meta' || k[0] === 'child-summary'
      }
    })
  }, [qc, collection, item])

  return { check, review }
}

/** One line per change: "Beth Smith changed Amount 1,200 → 1,450 · 3 min ago". */
export function unseenLine(c: UnseenChange): string {
  if (c.kind === 'field') {
    const from = c.from ?? 'empty'
    const to = c.to ?? 'empty'
    return `${c.by} changed ${c.label} ${from} → ${to}`
  }
  return `${c.by} ${c.text ?? `changed ${c.label}`}`
}

/** The confirm step's "changed since you opened it" block. Nothing when the list is empty. */
export function UnseenChangesNotice({ changes }: { changes: UnseenChange[] }) {
  if (changes.length === 0) return null
  const shown = changes.slice(0, 5)
  const rest = changes.length - shown.length
  return (
    <div
      data-unseen-changes
      role='status'
      className='rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100'
    >
      <p className='mb-1 flex items-center gap-1.5 font-semibold'>
        <Eye className='h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-300' aria-hidden />
        Changed since you opened it
      </p>
      <ul className='space-y-0.5'>
        {shown.map((c) => (
          <li
            key={`${c.scope}:${c.field ?? ''}:${c.at}`}
            className='flex min-w-0 items-baseline gap-1.5'
          >
            <span className='min-w-0 flex-1 break-words'>{unseenLine(c)}</span>
            <span className='shrink-0 text-[11px] text-sky-700/80 dark:text-sky-200/70'>
              {formatRelative(c.at)}
            </span>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className='mt-0.5 text-[11px] text-sky-700/80 dark:text-sky-200/70'>
          and {rest} more {rest === 1 ? 'change' : 'changes'}
        </p>
      )}
      <p className='mt-1 text-[11.5px] text-sky-800/80 dark:text-sky-200/80'>
        Review shows them on the page first. Continue moves it as it is now.
      </p>
    </div>
  )
}
