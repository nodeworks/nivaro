import { AlertTriangle } from 'lucide-react'
import { listLoadErrorText } from '../lib/load-error'

/**
 * A list read that failed — a 503 list timeout ("This search took too long to
 * finish…"), a busy server, anything else — said in place of the rows, with
 * Retry. Never the empty sentence: a failed read has no answer to borrow one
 * from. Rendered by the list itself above its table, not through the table's
 * empty slot.
 */
export function ListLoadError({
  error,
  onRetry,
  className = ''
}: {
  error: unknown
  onRetry: () => void
  className?: string
}) {
  return (
    <div
      role='alert'
      data-list-load-error
      className={`flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 ${className}`}
    >
      <AlertTriangle aria-hidden className='h-3.5 w-3.5 shrink-0' />
      <span className='min-w-0 flex-1'>{listLoadErrorText(error)}</span>
      <button
        type='button'
        onClick={onRetry}
        className='h-6 shrink-0 rounded border border-amber-400/60 bg-white px-2 text-[12px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/15'
      >
        Retry
      </button>
    </div>
  )
}
