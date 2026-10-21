import { cn } from '../../../lib/utils'

/** Below this, a field is rarely filled: the hint's tip says so. */
export const LOW_FILL_PCT = 10

/**
 * "3% filled" beside a field on the design canvas (#2588), in the Usage
 * lens only. Quiet slate in every case — amber stays for things that need
 * a look; a rarely filled field says so in its tip. Never takes a click.
 */
export function FillChip({ pct }: { pct: number }) {
  const whole = pct > 0 && pct < 1 ? '<1' : String(Math.round(pct))
  const low = pct < LOW_FILL_PCT
  return (
    <span
      data-design-fill={whole}
      data-fill-low={low ? '' : undefined}
      data-tip={low ? 'Rarely filled on this collection’s records' : undefined}
      className={cn(
        'inline-flex items-center rounded bg-white px-1 text-[10.5px] tabular-nums text-slate-500 ring-1 ring-slate-200 dark:bg-card dark:text-muted-foreground dark:ring-border',
        low && 'pointer-events-auto'
      )}
    >
      {whole}% filled
      <span className='sr-only'> on this collection's records</span>
    </span>
  )
}
