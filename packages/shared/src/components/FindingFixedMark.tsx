import { Check } from 'lucide-react'
import { useContext } from 'react'
import { ItemEditAuthContext } from '../context'
import { type ResolvedMark, resolvedLabel } from '../lib/live-findings'
import { useActorNames } from '../lib/live-list'

/**
 * The calm "Fixed by Beth" state of a finding whose record was just fixed (see
 * lib/live-findings.ts). Quiet green check + words, no animation; the row around it should be
 * dimmed by the board (`opacity-60`) and stays until the next refresh.
 */
export function FindingFixedMark({ mark, className }: { mark: ResolvedMark; className?: string }) {
  const { userId } = useContext(ItemEditAuthContext)
  const names = useActorNames(mark.by ? [mark.by] : [])
  const text = resolvedLabel(mark, mark.by ? names.get(mark.by) : null, userId)
  return (
    <span
      data-finding-fixed
      className={`inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-emerald-700 dark:text-emerald-400 ${className ?? ''}`}
    >
      <Check className='h-3 w-3' aria-hidden />
      {text}
    </span>
  )
}
