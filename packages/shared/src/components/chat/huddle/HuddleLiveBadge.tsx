import { Headphones } from 'lucide-react'
import { cn } from '../../../lib/utils'

/**
 * A headset badge with the head count for a room whose huddle is running (#2851). Renders
 * nothing for 0. Used by the room list, record tab strips and people cards.
 */
export function HuddleLiveBadge({
  count,
  label,
  className
}: {
  count: number
  /** Room name for the tooltip ("In a huddle in Ops"). */
  label?: string
  className?: string
}) {
  if (count <= 0) return null
  const tip = `${count} ${count === 1 ? 'person' : 'people'} in a huddle${label ? ` in ${label}` : ''}`
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-semibold tabular-nums text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        className
      )}
      data-tip={tip}
      role='img'
      aria-label={tip}
      data-huddle-live-badge={count}
    >
      <Headphones className='h-3 w-3' strokeWidth={2} />
      {count}
    </span>
  )
}

/** "In a huddle in Ops" for a people card; renders nothing without a visible huddle. */
export function HuddlePresenceLine({
  label,
  className
}: {
  label: string | null
  className?: string
}) {
  if (!label) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11.5px] text-emerald-700 dark:text-emerald-300',
        className
      )}
      data-huddle-presence
    >
      <Headphones className='h-3 w-3 shrink-0' strokeWidth={2} />
      In a huddle in {label}
    </span>
  )
}
