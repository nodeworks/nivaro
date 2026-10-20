// The record form's Summary rail while a layout is being edited: open or
// folded, remembered per person in this browser. Normal record pages never
// read or write it. Storage can throw (private windows, blocked site data):
// then the rail simply starts open.

const KEY = 'nvr:layout-editor:summary-collapsed'

const keyFor = (userId: string | null | undefined) => (userId ? `${KEY}:${userId}` : KEY)

export function readDesignSummaryCollapsed(userId: string | null | undefined): boolean {
  try {
    return window.localStorage.getItem(keyFor(userId)) === '1'
  } catch {
    return false
  }
}

export function writeDesignSummaryCollapsed(
  userId: string | null | undefined,
  collapsed: boolean
): void {
  try {
    if (collapsed) window.localStorage.setItem(keyFor(userId), '1')
    else window.localStorage.removeItem(keyFor(userId))
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}
