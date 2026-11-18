import { createContext, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

/**
 * The Issue trackers page has ONE action bar, under its scroller (not sticky inside it): unsaved
 * sync settings and the open rule each own a row of it. A row is portalled into its slot; with
 * no page around it (a component rendered on its own) the row renders in place, stuck to the
 * bottom of whatever scrolls it.
 */
export type ActionBarSlot = 'sync' | 'rule'
type Slots = Partial<Record<ActionBarSlot, HTMLElement | null>>

const SlotsContext = createContext<Slots | null>(null)
export const ActionBarSlots = SlotsContext.Provider

/** pr-16: the floating report-a-problem button sits over the bottom-right corner. */
const ROW =
  'flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-slate-200 bg-white py-2.5 pl-4 pr-16 sm:pl-6 dark:border-border dark:bg-card'

export function ActionBarRow({
  slot,
  children,
  className
}: {
  slot: ActionBarSlot
  children: ReactNode
  className?: string
}) {
  const slots = useContext(SlotsContext)
  const row = <div className={cn(ROW, className)}>{children}</div>
  if (!slots) return <div className='sticky bottom-0 z-10'>{row}</div>
  const target = slots[slot]
  return target ? createPortal(row, target) : null
}
