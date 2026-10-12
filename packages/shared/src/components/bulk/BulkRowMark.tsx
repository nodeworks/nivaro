import { AlertCircle, Check, Loader2, Minus } from 'lucide-react'
import { useBulkRowState } from '../../lib/bulk-progress'
import { cn } from '../../lib/utils'

/**
 * A row's place in the bulk run in progress (#1827): a spinner while the run is on it, then a
 * tick, a dash (skipped — already there) or the refusal reason. Renders nothing for a row that is
 * not part of the run, so it can sit in every row of a list.
 */
export function BulkRowMark({ rowId, className }: { rowId: string | number; className?: string }) {
  const state = useBulkRowState(rowId)
  if (!state) return null
  const base = 'inline-flex h-4 w-4 shrink-0 items-center justify-center'
  if (state.status === 'running')
    return (
      <span role='img' data-bulk-row='running' className={cn(base, className)} aria-label='Working'>
        <Loader2 className='h-3.5 w-3.5 animate-spin text-nvr-cyan' />
      </span>
    )
  if (state.status === 'queued')
    return (
      <span role='img' data-bulk-row='queued' className={cn(base, className)} aria-label='Waiting'>
        <span className='h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-600' />
      </span>
    )
  if (state.status === 'done')
    return (
      <span role='img' data-bulk-row='done' className={cn(base, className)} aria-label='Done'>
        <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' />
      </span>
    )
  if (state.status === 'skipped')
    return (
      <span
        role='img'
        data-bulk-row='skipped'
        data-tip='Nothing to change'
        className={cn(base, className)}
        aria-label='Skipped'
      >
        <Minus className='h-3.5 w-3.5 text-slate-400' />
      </span>
    )
  return (
    <span
      role='img'
      data-bulk-row='failed'
      data-tip={state.reason || 'Refused'}
      className={cn(base, className)}
      aria-label={state.reason || 'Refused'}
    >
      <AlertCircle className='h-3.5 w-3.5 text-rose-500' />
    </span>
  )
}
