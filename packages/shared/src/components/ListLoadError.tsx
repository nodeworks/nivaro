import { ErrorNotice } from './ErrorNotice'

/**
 * A list read that failed — a 503 list timeout ("This search took too long to
 * finish…"), a busy server, signed out, no access, anything else — said in
 * place of the rows with what to do and the one button that helps (usually
 * Try again). Never the empty sentence: a failed read has no answer to borrow
 * one from. Rendered by the list itself above its table, not through the
 * table's empty slot.
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
    <div data-list-load-error className={className}>
      <ErrorNotice variant='banner' error={error} what='this list' onRetry={onRetry} />
    </div>
  )
}
