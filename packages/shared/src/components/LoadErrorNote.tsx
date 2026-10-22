import { AlertTriangle, RotateCw } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * The degraded state for a widget or panel whose data did not load (#2858): what happened in
 * plain words and a way to try again, instead of a blank box, "No data" or a raw error string.
 */
export function LoadErrorNote({
  message,
  onRetry,
  className,
  centered = false
}: {
  message: string
  onRetry?: () => void
  className?: string
  centered?: boolean
}) {
  return (
    <div
      role='status'
      data-load-error=''
      className={cn(
        'flex gap-2 text-[12px] text-slate-600 dark:text-muted-foreground',
        centered ? 'flex-col items-center text-center' : 'items-start',
        className
      )}
    >
      <AlertTriangle
        className={cn('h-3.5 w-3.5 shrink-0 text-amber-500', !centered && 'mt-px')}
        aria-hidden
      />
      <div className={cn('min-w-0', centered && 'max-w-[240px]')}>
        <p className='leading-snug'>{message}</p>
        {onRetry && (
          <button
            type='button'
            onClick={onRetry}
            className='mt-1 inline-flex items-center gap-1 rounded text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
          >
            <RotateCw className='h-3 w-3' aria-hidden />
            Try again
          </button>
        )}
      </div>
    </div>
  )
}
