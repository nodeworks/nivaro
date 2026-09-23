import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn, formatRelative } from '../../../lib/utils'
import { Button } from '../../ui/button'

/**
 * One outbound submission — status, endpoint, reference, and on expand the
 * stored request/response plus every attempt. Shared by the record header's
 * External requests dialog and the Integrations console's partner detail.
 */
export interface ErpSubmission {
  id: number
  external_api: number | null
  external_api_name?: string | null
  external_ref: string | null
  status: string
  attempts: number
  last_error: string | null
  endpoint_path: string | null
  payload: unknown
  response: unknown
  created_at: string
  updated_at: string
}

function pretty(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return v
    }
  }
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const STATUS_TONE: Record<string, string> = {
  accepted: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  failed: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  pending: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  submitted: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
        STATUS_TONE[status] ?? 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
      )}
    >
      {status}
    </span>
  )
}

interface SubmissionAttempt {
  attempt: number
  status: string
  http_status: number | null
  error: string | null
  source: string
  at: string
  endpoint_path: string | null
  payload: unknown
  response: unknown
}

function CodeBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
        {label}
      </p>
      {value ? (
        <pre className='max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[10.5px] leading-relaxed text-slate-700 dark:bg-black/20 dark:text-slate-300'>
          {value}
        </pre>
      ) : (
        <p className='text-[11.5px] italic text-slate-400'>Nothing stored</p>
      )}
    </div>
  )
}

function AttemptItem({ a, latest }: { a: SubmissionAttempt; latest: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <li
      className='rounded-md border border-slate-200 dark:border-border'
      data-erp-attempt={a.attempt}
    >
      <button
        type='button'
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left'
      >
        <span className='w-16 shrink-0 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
          Attempt {a.attempt}
        </span>
        <StatusPill status={a.status} />
        {a.http_status != null && (
          <span className='shrink-0 font-mono text-[10.5px] text-slate-500 dark:text-slate-400'>
            HTTP {a.http_status}
          </span>
        )}
        {latest && (
          <span className='shrink-0 rounded bg-slate-100 px-1 text-[10px] text-slate-500 dark:bg-muted dark:text-slate-400'>
            latest
          </span>
        )}
        <span className='min-w-0 flex-1 truncate text-[11px] text-red-600 dark:text-red-400'>
          {a.error ?? ''}
        </span>
        <span
          className='shrink-0 text-[11px] text-slate-400'
          title={new Date(a.at).toLocaleString()}
        >
          {new Date(a.at).toLocaleString()}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <div className='space-y-2 border-t border-slate-100 px-2.5 py-2 dark:border-border'>
          {a.error && (
            <p className='rounded bg-red-50 px-2 py-1.5 text-[11.5px] text-red-700 dark:bg-red-500/10 dark:text-red-400'>
              {a.error}
            </p>
          )}
          <CodeBlock label='Request' value={pretty(a.payload)} />
          <CodeBlock label='Response' value={pretty(a.response)} />
        </div>
      )}
    </li>
  )
}

function AttemptHistory({ submissionId }: { submissionId: number }) {
  const client = useNivaroClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['erp-submission-attempts', submissionId],
    queryFn: () =>
      client
        .request<{ data: { attempts: SubmissionAttempt[]; total: number; unrecorded: number } }>(
          get(`/erp-submissions/${submissionId}/attempts`)
        )
        .then((r) => r.data),
    staleTime: 15_000
  })
  return (
    <div data-erp-attempts>
      <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
        Attempt history
      </p>
      {isLoading ? (
        <div className='h-8 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
      ) : isError || !data ? (
        <p className='text-[11.5px] italic text-slate-400'>Could not load the attempt history.</p>
      ) : (
        <>
          <ul className='space-y-1.5'>
            {data.attempts.map((a, i) => (
              <AttemptItem key={a.attempt} a={a} latest={i === 0} />
            ))}
          </ul>
          {data.unrecorded > 0 && (
            <p className='mt-1.5 text-[11px] text-slate-400' data-erp-attempts-unrecorded>
              {data.unrecorded} earlier attempt{data.unrecorded !== 1 ? 's were' : ' was'} made
              before attempt history was kept — only the outcome count survives.
            </p>
          )}
        </>
      )}
    </div>
  )
}

export function SubmissionRow({
  sub,
  onRetry,
  retrying
}: {
  sub: ErpSubmission
  onRetry: (id: number) => void
  retrying: boolean
}) {
  const [open, setOpen] = useState(false)
  const payload = pretty(sub.payload)
  const response = pretty(sub.response)
  return (
    <div className='rounded-lg border border-slate-200 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-3 px-3 py-2 text-left'
      >
        <StatusPill status={sub.status} />
        {sub.external_api_name && (
          <span className='shrink-0 text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
            {sub.external_api_name}
          </span>
        )}
        <span className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-500 dark:text-slate-400'>
          {sub.endpoint_path ?? '—'}
        </span>
        {sub.external_ref && (
          <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600 dark:bg-muted dark:text-slate-300'>
            {sub.external_ref}
          </span>
        )}
        <span
          className='shrink-0 text-[11px] text-slate-400'
          title={new Date(sub.updated_at).toLocaleString()}
        >
          {formatRelative(sub.updated_at)}
        </span>
        {sub.attempts > 1 && (
          <span className='shrink-0 text-[10.5px] text-slate-400'>×{sub.attempts}</span>
        )}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <div className='space-y-2 border-t border-slate-100 px-3 py-2.5 dark:border-border'>
          <div className='grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
            <span>Sent: {new Date(sub.created_at).toLocaleString()}</span>
            <span>Last update: {new Date(sub.updated_at).toLocaleString()}</span>
            <span>Attempts: {sub.attempts}</span>
            <span>
              API:{' '}
              {sub.external_api_name ?? (sub.external_api != null ? `#${sub.external_api}` : '—')}
            </span>
          </div>
          {sub.last_error && (
            <p className='rounded bg-red-50 px-2 py-1.5 text-[11.5px] text-red-700 dark:bg-red-500/10 dark:text-red-400'>
              {sub.last_error}
            </p>
          )}
          <CodeBlock
            label={sub.attempts > 1 ? 'Latest request' : 'Request payload'}
            value={payload}
          />
          <CodeBlock label={sub.attempts > 1 ? 'Latest response' : 'Response'} value={response} />
          {sub.attempts > 1 && <AttemptHistory submissionId={sub.id} />}
          {sub.status === 'failed' && (
            <Button size='sm' variant='outline' disabled={retrying} onClick={() => onRetry(sub.id)}>
              {retrying ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <RefreshCw className='h-3 w-3' />
              )}
              <span className='ml-1.5'>Retry</span>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
