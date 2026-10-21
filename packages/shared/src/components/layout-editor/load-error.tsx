import { cn } from '../../lib/utils'

/**
 * A read that failed, said as such with a way to try again — never shown as
 * an empty list ("No pipeline is bound…") when the list could not be read.
 */
export function LoadError({
  what,
  onRetry,
  className
}: {
  /** What could not be loaded: "the workflow states". */
  what: string
  onRetry: () => void
  className?: string
}) {
  return (
    <p
      role='alert'
      data-load-error=''
      className={cn(
        'm-0 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-snug text-red-700 dark:text-red-300',
        className
      )}
    >
      Could not load {what}.
      <button
        type='button'
        data-load-retry=''
        onClick={onRetry}
        className='font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
      >
        Retry
      </button>
    </p>
  )
}
