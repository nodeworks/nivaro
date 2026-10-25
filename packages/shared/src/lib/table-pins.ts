/** Share of a table's visible width its pinned columns may cover together. */
export const PIN_BUDGET = 0.6

/**
 * Which of a table's pinned columns stay pinned at the current width.
 *
 * Pins that cover the whole visible width leave nothing to scroll, and the
 * right-pinned block then paints over the left-pinned identifier (a phone
 * worklist showed only State / Owners / Actions — no row said which record it
 * was). Pins are kept while they fit the budget: the first left pin (the
 * record's identifier) always, then the other left pins in order, then right
 * pins from the outer edge in — a sticky right column's offset counts from the
 * edge, so the kept right pins must stay contiguous with it. Columns dropped
 * here keep their place and simply scroll.
 */
export function fitPins(
  left: string[],
  right: string[],
  widthOf: (key: string) => number,
  leadWidth: number,
  viewport: number
): { left: string[]; right: string[] } {
  // Not measured yet (hidden, first paint): pin as configured.
  if (viewport <= 0) return { left, right }
  const budget = viewport * PIN_BUDGET
  let used = leadWidth
  const keptLeft: string[] = []
  for (const key of left) {
    const w = widthOf(key)
    if (keptLeft.length > 0 && used + w > budget) break
    keptLeft.push(key)
    used += w
  }
  const keptRight: string[] = []
  for (let i = right.length - 1; i >= 0; i--) {
    const w = widthOf(right[i])
    if (used + w > budget) break
    keptRight.unshift(right[i])
    used += w
  }
  return { left: keptLeft, right: keptRight }
}
