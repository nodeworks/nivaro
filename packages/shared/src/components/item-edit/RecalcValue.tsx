import type { ReactNode } from 'react'
import { useLivePreference } from '../../lib/live-preference'
import { cn } from '../../lib/utils'

/**
 * A total the server is recalculating (rt7 #9, lib/rollup-recalc.ts): the old figure stays in
 * place, dimmed, with a quiet "Updating…" beside it — never shown as final, never moved. When the
 * new figure lands it fades in once (`nvr-value-pulse`; none in Calm or under reduced motion).
 */
export type RecalcState = 'pending' | 'landed'

export function recalcStateOf(options: unknown): RecalcState | null {
  if (!options || typeof options !== 'object') return null
  const v = (options as { __recalc?: unknown }).__recalc
  return v === 'pending' || v === 'landed' ? v : null
}

export function RecalcValue({
  state,
  children,
  className,
  inline
}: {
  state: RecalcState | null
  children: ReactNode
  className?: string
  /** Header strip: a smaller label on the same line. */
  inline?: boolean
}) {
  const { quiet } = useLivePreference()
  if (state === 'landed')
    return (
      <span data-recalc='landed' className={cn('nvr-value-pulse', className)}>
        {children}
      </span>
    )
  if (state !== 'pending') return <>{children}</>
  return (
    <span
      data-recalc='pending'
      aria-busy='true'
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
    >
      <span className='min-w-0 opacity-45 transition-opacity duration-200'>{children}</span>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-medium text-slate-500 dark:text-slate-400',
          inline ? 'text-[10px]' : 'text-[11px]'
        )}
        data-tip='The lines changed — this total is being recalculated'
      >
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 rounded-full bg-nvr-cyan',
            // Calm / Off: the state shows, it does not move.
            !quiet && 'motion-safe:animate-pulse'
          )}
        />
        Updating…
      </span>
    </span>
  )
}
