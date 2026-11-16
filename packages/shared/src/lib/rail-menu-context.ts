import { createContext, useContext } from 'react'

/**
 * Set by OverflowRail's ⋯ menu around the controls folded into it. A popover opened from one
 * of those controls (Group, Columns, Send view…) reads it to open BESIDE the menu instead of
 * on top of its rows, fit the viewport with its own scroll, and tell the menu it is open
 * (on a phone the menu steps aside while it is). ui/popover.tsx resets it for the popover's
 * own content, so a picker inside that popover behaves normally.
 */
export interface RailMenuContextValue {
  /** Called with +1 when a popover opened from the menu appears, -1 when it goes. */
  nested: (delta: 1 | -1) => void
  /** Below md: there is no room beside the menu, so popovers open below their control. */
  compact: boolean
  /** The page's own area: popovers from the menu keep inside it (clear of the sidebar). */
  boundary: () => Element | null
}

export const RailMenuContext = createContext<RailMenuContextValue | null>(null)

export function useRailMenu(): RailMenuContextValue | null {
  return useContext(RailMenuContext)
}
