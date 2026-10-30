import { ErrorNotice } from './ErrorNotice'

/**
 * The page-level error state for a read that failed (#2857): "Couldn't load <thing>" with what
 * to do and the one button that helps (Try again, Sign in again, Ask for access…), in place of a
 * blank screen, an empty state that reads as "no data" or a skeleton that never ends. Fill the
 * area the content would have used. The reference stays in "Details for support".
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
  return (
    <ErrorNotice variant='page' error={error} what={what} onRetry={onRetry} className={className} />
  )
}
