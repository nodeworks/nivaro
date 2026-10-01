import type { ComponentType } from 'react'
import { byOrder, FeatureBoundary, type Registered } from './registry'

/**
 * Where a header extra sits:
 * - `lead`: first in the filter bar (the natural-language view builder)
 * - `filters` (default): after Window, beside the other filters and lenses
 * - `status`: the title row, beside the live status (presence, open breakers)
 * - `actions`: the right end of the filter bar (record, share, links)
 * - `menu`: inside the "More" menu (preferences that are set once)
 */
export type ToolbarSlot = 'lead' | 'filters' | 'status' | 'actions' | 'menu'

export interface ToolbarItem extends Registered {
  Component: ComponentType
  slot?: ToolbarSlot
}

export const toolbarItems: ToolbarItem[] = []

export function toolbarItemsIn(slot: ToolbarSlot): ToolbarItem[] {
  return byOrder(toolbarItems).filter((t) => (t.slot ?? 'filters') === slot)
}

export function ToolbarItems({ slot = 'filters' }: { slot?: ToolbarSlot }) {
  const list = toolbarItemsIn(slot)
  if (list.length === 0) return null
  return (
    <>
      {list.map((t) => (
        <FeatureBoundary key={t.id} id={t.id}>
          <t.Component />
        </FeatureBoundary>
      ))}
    </>
  )
}
