import { newCountLabel } from '../../lib/seen-since'

/**
 * "2 new" beside a folded panel's name (lib/seen-since.ts): what other people
 * added since you last had it open. Quiet — a tinted pill, a short fade in
 * (none under reduced motion).
 */
export function NewSinceChip({ count, tab }: { count: number; tab: string }) {
  const label = newCountLabel(count)
  if (!label) return null
  return (
    <span
      data-new-since={tab}
      className='nvr-fade-in rounded-full bg-nvr-cyan/10 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-nvr-navy motion-reduce:animate-none dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
    >
      {label}
    </span>
  )
}
