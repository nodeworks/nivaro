import { AlertCircle, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'

export interface ValidationSummaryItem {
  field: string
  label: string
  message: string
  /** Step / tab / section the field lives on — shown when the form has more than one. */
  location?: string | null
}

const COLLAPSED_LIMIT = 6

/**
 * "Can't save yet" — the inline summary a failed save leaves at the top of the
 * record body. One row per problem, in form order, each a button that jumps
 * to (and, on steps layouts, switches to) the field. The field's own inline
 * error stays; this is the map. Dismissable; the host unmounts it as soon as
 * the errors clear.
 */
export function ValidationSummary({
  items,
  onJump,
  onDismiss
}: {
  items: ValidationSummaryItem[]
  onJump: (field: string) => void
  onDismiss: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const n = items.length
  const locations = new Set(items.map((i) => i.location).filter(Boolean))
  const showLocation = locations.size > 1 || (locations.size === 1 && items.some((i) => !i.location))
  const visible = expanded ? items : items.slice(0, COLLAPSED_LIMIT)
  const hidden = n - visible.length
  return (
    <div
      role='alert'
      aria-live='polite'
      data-validation-summary
      className='rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 dark:border-red-500/30 dark:bg-red-400/10'
    >
      <div className='flex items-center gap-2'>
        <AlertCircle className='h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400' aria-hidden />
        <span className='text-[12.5px] font-medium text-red-800 dark:text-red-300'>
          Can’t save yet — {n} field{n === 1 ? '' : 's'} need{n === 1 ? 's' : ''} attention
        </span>
        <button
          type='button'
          onClick={onDismiss}
          aria-label='Dismiss'
          className='ml-auto rounded p-0.5 text-red-500 hover:bg-red-100 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-400/20'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <ul className='mt-1.5 space-y-0.5'>
        {visible.map((it) => (
          <li key={it.field} className='flex items-baseline gap-2 text-[12px]'>
            <button
              type='button'
              onClick={() => onJump(it.field)}
              className='shrink-0 font-medium text-red-800 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-red-300'
            >
              {it.label}
            </button>
            <span className='min-w-0 flex-1 text-red-800/90 dark:text-red-200/90'>{it.message}</span>
            {showLocation && it.location && (
              <span className='shrink-0 text-[11px] text-red-600/80 dark:text-red-400/70'>
                {it.location}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type='button'
          onClick={() => setExpanded(true)}
          className={cn(
            'mt-1 text-[11.5px] font-medium text-red-700 underline decoration-dotted underline-offset-2 dark:text-red-300'
          )}
        >
          Show {hidden} more
        </button>
      )}
    </div>
  )
}
