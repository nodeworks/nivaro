// The record form's Summary rail while a layout is being edited: open or
// folded, remembered per person in this browser. Normal record pages never
// read or write it. Never chosen: open, unless the canvas is too narrow for
// the form and the rail side by side. Storage can throw (private windows,
// blocked site data): then it is as if nothing was chosen.

const KEY = 'nvr:layout-editor:summary-collapsed'

const keyFor = (userId: string | null | undefined) => (userId ? `${KEY}:${userId}` : KEY)

/** The stored fold: true / false, or null when this person never chose. */
export function readDesignSummaryCollapsed(userId: string | null | undefined): boolean | null {
  try {
    const v = window.localStorage.getItem(keyFor(userId))
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** Below this much form width beside the rail, an unchosen rail starts folded. */
export const DESIGN_SUMMARY_MIN_CANVAS = 720

export function writeDesignSummaryCollapsed(
  userId: string | null | undefined,
  collapsed: boolean
): void {
  try {
    window.localStorage.setItem(keyFor(userId), collapsed ? '1' : '0')
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}
