import { cn } from '../../../lib/utils'

/** Below this, a field is rarely filled: the hint says so in amber. */
export const LOW_FILL_PCT = 10

/** "3% filled" beside a field on the design canvas (#2588). Decorative: never takes a click. */
export function FillChip({ pct }: { pct: number }) {
  const whole = pct > 0 && pct < 1 ? '<1' : String(Math.round(pct))
  return (
    <span
      data-design-fill={whole}
      className={cn(
        'inline-flex items-center rounded bg-white px-1 text-[10.5px] tabular-nums ring-1 ring-slate-200 dark:bg-card dark:ring-border',
        pct < LOW_FILL_PCT
          ? 'text-amber-700 dark:text-amber-300'
          : 'text-slate-500 dark:text-muted-foreground'
      )}
    >
      {whole}% filled
      <span className='sr-only'> on this collection's records</span>
    </span>
  )
}
