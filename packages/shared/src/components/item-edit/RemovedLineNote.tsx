import { Copy, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatRelative } from '../../lib/utils'
import {
  type LineRemovedBy,
  removedLineName,
  removedLineText,
  unsavedLineText
} from './removed-line'

export interface RemovedLineState {
  rowId: string
  label: string
  /** The line's position (1-based) when it was removed — "Line 3". */
  lineNumber?: number | null
  /** What "Restore as new line" starts from (the line as it was + the person's input). */
  row: Record<string, unknown>
  /** The person's unsaved input for the line. */
  changes: Record<string, unknown>
  by: LineRemovedBy | null
  at: number
}

/**
 * Realtime round 7 #6 — the calm note a lines grid shows when the line the person was in was
 * removed by someone else: who removed it, which line, when, and (when they had typed into it)
 * a chip that keeps their unsaved input with Copy / Restore as new line. The words are built
 * from parts, never joined around an empty one.
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
  const details = [
    removedLineName(state.label, state.lineNumber),
    state.by?.at ? formatRelative(state.by.at) : ''
  ].filter((p) => p.trim() !== '')
  return (
    <div
      data-line-removed={state.rowId}
      role='status'
      className='nvr-expand-in flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 py-2 pr-1.5 pl-3 text-[11.5px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
    >
      <div className='flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5'>
        <p className='min-w-0 leading-snug'>
          {/* Inline, so it sits on the words' first line however the row wraps. */}
          <span
            aria-hidden
            className='mr-2 inline-block h-1.5 w-1.5 rounded-full bg-slate-400 align-middle dark:bg-slate-500'
          />
          <span className='font-medium'>{removedLineText(state.by, selfId)}</span>
          {details.map((d) => (
            <span key={d} className='text-slate-500 dark:text-slate-400'>
              {' · '}
              {d}
            </span>
          ))}
        </p>
        {kept.length > 0 && (
          <div
            data-line-removed-kept=''
            className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-amber-200 bg-amber-50 py-1 pr-1 pl-2 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100'
          >
            <span className='min-w-0 leading-snug'>
              Your unsaved changes to the removed line:{' '}
              <span className='font-medium'>{kept.map(labelOf).join(', ')}</span>
            </span>
            <span className='flex shrink-0 items-center gap-1'>
              <button
                type='button'
                data-line-removed-copy=''
                onClick={() => {
                  navigator.clipboard.writeText(unsavedLineText(state.changes, labelOf)).then(
                    () => toast.success('Copied your changes'),
                    () => toast.error('Could not copy')
                  )
                }}
                className='inline-flex h-6 items-center gap-1 rounded-md border border-amber-300 bg-white px-2 text-[11px] font-medium text-amber-900 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 dark:border-amber-400/40 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-400/15'
              >
                <Copy aria-hidden className='h-3 w-3' />
                Copy
              </button>
              {!readOnly && (
                <button
                  type='button'
                  data-line-removed-restore=''
                  onClick={() => onRestore(state.row)}
                  className='inline-flex h-6 items-center rounded-md bg-amber-600 px-2 text-[11px] font-semibold text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
                >
                  Restore as new line
                </button>
              )}
            </span>
          </div>
        )}
      </div>
      <button
        type='button'
        aria-label='Dismiss'
        onClick={onDismiss}
        className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
