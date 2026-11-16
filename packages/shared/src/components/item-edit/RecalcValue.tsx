import type { ReactNode } from 'react'
import { useLivePreference } from '../../lib/live-preference'
import { cn } from '../../lib/utils'

/**
 * A total the server is recalculating (rt7 #9, lib/rollup-recalc.ts): the old figure stays in
 * place in muted grey with a quiet "Updating…" beside it (in the header strip: a dotted underline
 * on the figure, so the band never reflows) — never shown as final, never moved. When the new figure
 * lands it fades in once (`nvr-value-pulse`; none in Calm or under reduced motion).
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
      <span
        data-recalc='landed'
        className={cn(
          'nvr-value-pulse',
          // Header strip: keep the value line's own gap (figure · Σ).
          inline && 'inline-flex min-w-0 items-baseline gap-x-1.5',
          className
        )}
      >
        {children}
      </span>
    )
  if (state !== 'pending') return <>{children}</>
  const tip = 'Updating — this total is being recalculated from the lines'
  const dot = (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan',
        // Calm / Off: the state shows, it does not move.
        !quiet && 'motion-safe:animate-pulse'
      )}
    />
  )
  // The old figure turns muted grey (not faded: a faded brand-coloured figure fell under 3:1),
  // whatever colour its own classes give it — readable, and plainly not the final number.
  const stale =
    'min-w-0 text-slate-500 dark:text-slate-400 [&_*]:!text-inherit transition-colors duration-200'
  if (inline)
    // Header strip: no word or dot beside the figure — a word widened the cell and reflowed the
    // whole band, and anything outside the figure's box is cut by the tile's truncation. The
    // figure itself says it: muted grey with a dotted brand-colour underline (no room taken),
    // the word for screen readers, the reason in the tooltip.
    return (
      <span
        data-recalc='pending'
        aria-busy='true'
        data-tip={tip}
        className={cn('inline-flex min-w-0 items-baseline gap-x-1.5', stale, className)}
      >
        <span className='min-w-0 underline decoration-nvr-cyan decoration-dotted decoration-2 underline-offset-[3px]'>
          {children}
        </span>
        <span className='sr-only'>Updating…</span>
      </span>
    )
  return (
    <span
      data-recalc='pending'
      aria-busy='true'
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
    >
      <span className={stale}>{children}</span>
      <span
        className='inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium text-slate-500 dark:text-slate-400'
        data-tip={tip}
      >
        {dot}
        Updating…
      </span>
    </span>
  )
}
