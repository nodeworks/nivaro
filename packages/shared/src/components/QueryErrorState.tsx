import { loadErrorText, serverErrorText } from '../lib/load-error'
import { cn } from '../lib/utils'
import { LoadErrorNote } from './LoadErrorNote'

/**
 * The page-level error state for a read that failed (#2857): "Couldn't load <thing>." with the
 * short reason and Try again, in place of a blank screen, an empty state that reads as "no data"
 * or a skeleton that never ends. Fill the area the content would have used.
 */
export function QueryErrorState({
  error,
  what,
  onRetry,
  className
}: {
  error: unknown
  /** Lower-case noun for the sentence: "files", "this dashboard". */
  what: string
  onRetry?: () => void
  className?: string
}) {
  const server = serverErrorText(error)
  const message = server ? `Couldn’t load ${what}. ${server}` : loadErrorText(error, what)
  return (
    <div className={cn('flex min-h-[200px] flex-1 items-center justify-center p-8', className)}>
      <LoadErrorNote centered message={message} onRetry={onRetry} className='max-w-[320px]' />
    </div>
  )
}
