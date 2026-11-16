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
  viewport: number,
  opts: {
    compact?: boolean
    /** Cap on the right-hand pins alone, as a share of the visible width (the record list:
     *  State / Owners / Actions there squeezed Name out of sight at 1280 px). */
    rightShare?: number
    /** Which right pins give way first: lower ranks are released before higher ones
     *  (ties keep the outer-edge rule). The kept right pins come back in the caller's
     *  order; a host that ranks must move the released ones out of the pinned block so
     *  the kept ones stay contiguous with the edge. */
    rank?: (key: string) => number
  } = {}
): { left: string[]; right: string[] } {
  // Phone width: only the record's identifier stays pinned, everything else scrolls.
  // Pinned blocks on a 390 px screen leave the scrolling part a strip a few letters wide.
  if (opts.compact) return { left: left.slice(0, 1), right: [] }
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
  const rightBudget =
    opts.rightShare != null ? viewport * opts.rightShare : Number.POSITIVE_INFINITY
  const rank = opts.rank
  // Stable sort: equal ranks keep the outer-edge order.
  const order = rank
    ? right
        .map((key, i) => ({ key, i, r: rank(key) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((e) => e.key)
    : right
  const kept = new Set<string>()
  let rightUsed = 0
  for (let i = order.length - 1; i >= 0; i--) {
    const w = widthOf(order[i])
    if (used + w > budget || rightUsed + w > rightBudget) break
    kept.add(order[i])
    used += w
    rightUsed += w
  }
  return { left: keptLeft, right: right.filter((k) => kept.has(k)) }
}
