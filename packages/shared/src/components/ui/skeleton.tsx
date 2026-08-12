import { cn } from '../../lib/utils'

/**
 * Loading placeholder. Uses the dedicated `--nvr-skeleton` surface rather than
 * `--muted`: muted carries the palette's blue shift in dark mode, which made
 * every loading row read as a blue block.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-[hsl(var(--nvr-skeleton))]', className)}
      {...props}
    />
  )
}

export { Skeleton }
