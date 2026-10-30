import { AlertTriangle, RotateCw } from 'lucide-react'
import { plainErrorText } from '../lib/safe-error'
import { cn } from '../lib/utils'
import { ErrorNotice } from './ErrorNotice'

/**
 * The degraded state for a widget or panel whose data did not load (#2858): what happened in
 * plain words and a way to try again, instead of a blank box, "No data" or a raw error string.
 *
 * Pass the `error` itself (with `what`, "this widget") to get the full reading — what to do,
 * the one right button (Sign in again, Ask for access…) and "Details for support". A `message`
 * alone still works; raw text in it ("Request failed with status code 500") is never shown.
 */
export function LoadErrorNote({
  message,
  error,
  what,
  onRetry,
  className,
  centered = false
}: {
  message?: string
  error?: unknown
  what?: string
  onRetry?: () => void
  className?: string
  centered?: boolean
}) {
  if (error !== undefined && error !== null && !message) {
    return (
      <ErrorNotice
        error={error}
        what={what ?? 'this'}
        onRetry={onRetry}
        variant='inline'
        centered={centered}
        className={className}
      />
    )
  }
  const text = plainErrorText(message, 'Couldn’t load this.')
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
        <p className='leading-snug [text-wrap:balance]'>{text}</p>
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
