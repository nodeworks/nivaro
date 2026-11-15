import { EyeOff } from 'lucide-react'
import { type PickerBadge, type PickerBadgeTone, useRecordBadges } from '../../lib/picker-badges'
import { cn } from '../../lib/utils'

/**
 * The small status marks beside a record in a picker (realtime round 6, item 12). Quiet by
 * design: a word in a tinted capsule, never a colour alone — the label is the meaning, the tone
 * only ranks it (amber = needs a look, red = a problem, neutral = a fact, dashed = hidden).
 */

const TONE: Record<PickerBadgeTone, string> = {
  neutral:
    'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-white/[0.06] dark:text-slate-300 dark:ring-white/10',
  amber:
    'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/25',
  red: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-400/10 dark:text-red-200 dark:ring-red-400/25',
  muted:
    'border border-dashed border-slate-300 text-slate-500 dark:border-slate-600 dark:text-slate-400'
}

export function PickerBadgeList({
  badges,
  className
}: {
  badges: PickerBadge[] | undefined
  className?: string
}) {
  if (!badges || badges.length === 0) return null
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1', className)}
      data-picker-badges=''
    >
      {badges.map((b) => (
        <span
          key={b.key}
          data-picker-badge={b.key}
          className={cn(
            'inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-[4px] px-1.5 text-[10.5px] font-medium leading-[18px] tracking-[0.01em] nvr-fade-in',
            TONE[b.tone] ?? TONE.neutral
          )}
        >
          {b.key === 'hidden' && <EyeOff aria-hidden='true' className='h-2.5 w-2.5' />}
          {b.label}
        </span>
      ))}
    </span>
  )
}

/** Badges for one picked record (a field's value, a chip), live for that record. */
export function RecordPickerBadges({
  collection,
  id,
  className
}: {
  collection: string | null | undefined
  id: unknown
  className?: string
}) {
  const badges = useRecordBadges(
    collection,
    typeof id === 'string' || typeof id === 'number' ? id : null
  )
  return <PickerBadgeList badges={badges} className={className} />
}
