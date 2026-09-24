import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../../lib/utils'
import { useSubmissionAttempts } from '../api'
import type { Requester, SubmissionAttempt } from '../types'
import { CodeBlock, pretty } from './json'
import { RequesterChip } from './requester'
import { StatusPill } from './status'

function AttemptItem({
  a,
  latest,
  requester
}: {
  a: SubmissionAttempt
  latest: boolean
  requester?: Requester
}) {
  const [open, setOpen] = useState(false)
  return (
    <li className='rounded-md border border-border' data-erp-attempt={a.attempt}>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className='flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
      >
        <span className='w-16 shrink-0 text-[11px] font-semibold text-foreground'>
          Attempt {a.attempt}
        </span>
        <StatusPill status={a.status} />
        {a.http_status != null && (
          <span className='shrink-0 font-mono text-[10.5px] text-muted-foreground'>
            HTTP {a.http_status}
          </span>
        )}
        {latest && (
          <span className='shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground'>
            latest
          </span>
        )}
        <span className='min-w-0 flex-1 truncate text-[11px] text-red-600 dark:text-red-400'>
          {a.error ?? ''}
        </span>
        {requester && (
          // Always shown (no hidden/md:… pair — a host sheet that re-declares
          // `.hidden` after ours would win and hide it at every width).
          <span className='inline-flex min-w-0 max-w-[38%] shrink' data-erp-attempt-by>
            <RequesterChip r={requester} size='sm' />
          </span>
        )}
        <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>
          {new Date(a.at).toLocaleString()}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className='space-y-2 border-t border-border px-2.5 py-2'>
          {a.error && (
            <p className='whitespace-pre-wrap break-words rounded bg-red-50 px-2 py-1.5 text-[11.5px] text-red-700 dark:bg-red-500/10 dark:text-red-400'>
              {a.error}
            </p>
          )}
          <CodeBlock label='Request' value={pretty(a.payload)} fold />
          <CodeBlock label='Response' value={pretty(a.response)} fold />
        </div>
      )}
    </li>
  )
}

/**
 * Every attempt of one submission, newest first, each opening to its own
 * request and response. `requesters` (attempt number → who started it) comes
 * from the drill-down's detail; without it the list reads as before.
 */
export function AttemptHistory({
  submissionId,
  requesters,
  title = 'Attempt history'
}: {
  submissionId: number
  requesters?: Map<number, Requester>
  title?: string | null
}) {
  const { data, isLoading, isError } = useSubmissionAttempts(submissionId)
  return (
    <div data-erp-attempts>
      {title && <p className='mb-1 text-[11.5px] font-semibold text-muted-foreground'>{title}</p>}
      {isLoading ? (
        <div className='h-8 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
      ) : isError || !data ? (
        <p className='text-[11.5px] italic text-muted-foreground'>
          Could not load the attempt history.
        </p>
      ) : (
        <>
          <ul className='space-y-1.5'>
            {data.attempts.map((a, i) => (
              <AttemptItem
                key={a.attempt}
                a={a}
                latest={i === 0}
                requester={requesters?.get(a.attempt)}
              />
            ))}
          </ul>
          {data.unrecorded > 0 && (
            <p className='mt-1.5 text-[11px] text-muted-foreground' data-erp-attempts-unrecorded>
              {data.unrecorded} earlier attempt{data.unrecorded !== 1 ? 's were' : ' was'} made
              before attempt history was kept — only the outcome count survives.
            </p>
          )}
        </>
      )}
    </div>
  )
}
