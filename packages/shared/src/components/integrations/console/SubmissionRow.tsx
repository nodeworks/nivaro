import { ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { cn, formatRelative, titleCase } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { AttemptHistory } from './drill/attempts'
import { CodeBlock, pretty } from './drill/json'
import { StatusPill } from './drill/status'

// The attempt history and body viewer live in drill/ — shared with the
// Firefight drill-down so the two never render a push differently.
export { StatusPill }

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
  collection: string
  item: string
  /** The record's friendly (human-facing) id — present only where the
   *  caller batch-resolved it (the partner detail's cross-record listing).
   *  A record page hosting its OWN External requests dialog already IS that
   *  record, so it never needs this badge and doesn't send it. */
  record_label?: string
}

/** "Workflows · CR26-80361" — never the raw "workflows/371425" pair. */
function recordBadgeLabel(collection: string, label: string): string {
  const word = titleCase(collection).replace(/s$/, '')
  return `${word} · ${label}`
}

export function SubmissionRow({
  sub,
  onRetry,
  retrying,
  onShowPath
}: {
  sub: ErpSubmission
  onRetry: (id: number) => void
  retrying: boolean
  /** Opens the full integration path (write → transition → push → reply)
   *  behind this submission. Absent = no "Show path" action. */
  onShowPath?: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const payload = pretty(sub.payload)
  const response = pretty(sub.response)
  return (
    <div className='rounded-lg border border-slate-200 dark:border-border'>
      <div className='flex items-center'>
        <button
          type='button'
          onClick={() => setOpen(!open)}
          className='flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left'
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
          {sub.record_label && (
            <span
              className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'
              data-tip={`${sub.collection}/${sub.item}`}
            >
              {recordBadgeLabel(sub.collection, sub.record_label)}
            </span>
          )}
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
        {onShowPath && (
          <button
            type='button'
            onClick={() => onShowPath(sub.id)}
            className='mr-2 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
            data-submission-show-path={sub.id}
            data-tip='Everything that led to this push and what came back'
          >
            Show path
          </button>
        )}
      </div>
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
