import { X } from 'lucide-react'
import { toast } from 'sonner'
import { formatRelative } from '../../lib/utils'
import {
  cleanLineLabel,
  type LineRemovedBy,
  removedLineText,
  unsavedLineText
} from './removed-line'

export interface RemovedLineState {
  rowId: string
  label: string
  /** What "Restore as new line" starts from (the line as it was + the person's input). */
  row: Record<string, unknown>
  /** The person's unsaved input for the line. */
  changes: Record<string, unknown>
  by: LineRemovedBy | null
  at: number
}

/**
 * Realtime round 7 #6 — the calm note a lines grid shows when the line the person was in was
 * removed by someone else: who removed it, and (when they had typed into it) a chip that keeps
 * their unsaved input with Copy / Restore as new line.
 */
export function RemovedLineNote({
  state,
  labelOf,
  selfId,
  readOnly,
  onRestore,
  onDismiss
}: {
  state: RemovedLineState
  labelOf: (field: string) => string
  selfId?: string | null
  readOnly?: boolean
  onRestore: (row: Record<string, unknown>) => void
  onDismiss: () => void
}) {
  const kept = Object.keys(state.changes)
  return (
    <div
      data-line-removed={state.rowId}
      role='status'
      className='nvr-expand-in flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11.5px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
    >
      <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400 dark:bg-slate-500' />
      <span className='min-w-0'>
        <span className='font-medium'>{removedLineText(state.by, selfId)}</span>
        {cleanLineLabel(state.label) ? (
          <span className='text-slate-500 dark:text-slate-400'>
            {' '}
            · {cleanLineLabel(state.label)}
          </span>
        ) : null}
        {state.by?.at ? (
          <span className='text-slate-500 dark:text-slate-400'>
            {' '}
            · {formatRelative(state.by.at)}
          </span>
        ) : null}
      </span>
      {kept.length > 0 && (
        <span
          data-line-removed-kept=''
          className='inline-flex flex-wrap items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 py-0.5 pl-2 pr-1 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100'
        >
          <span>
            Your unsaved changes to the removed line:{' '}
            <span className='font-medium'>{kept.map(labelOf).join(', ')}</span>
          </span>
          <button
            type='button'
            data-line-removed-copy=''
            onClick={() => {
              navigator.clipboard.writeText(unsavedLineText(state.changes, labelOf)).then(
                () => toast.success('Copied your changes'),
                () => toast.error('Could not copy')
              )
            }}
            className='rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 dark:hover:bg-amber-400/15'
          >
            Copy
          </button>
          {!readOnly && (
            <button
              type='button'
              data-line-removed-restore=''
              onClick={() => onRestore(state.row)}
              className='rounded bg-amber-600 px-1.5 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
            >
              Restore as new line
            </button>
          )}
        </span>
      )}
      <button
        type='button'
        aria-label='Dismiss'
        onClick={onDismiss}
        className='ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
      >
        <X className='h-3 w-3' />
      </button>
    </div>
  )
}
