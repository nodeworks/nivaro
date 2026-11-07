/**
 * The list's roving tab stop (army8 review M9): ONE row is in the tab order,
 * so Tab reaches the list once and then moves on to the pager.
 */

/** The row key holding the tab stop: the last row focused while it is still
 *  listed, else the first row; null when nothing is listed. */
export function tabStopRowKey(
  entries: ReadonlyArray<{ kind: string; row?: { id?: unknown } }>,
  focusedKey: string | null
): string | null {
  let first: string | null = null
  for (const e of entries) {
    if (e.kind !== 'row' || !e.row) continue
    const k = String(e.row.id)
    if (k === focusedKey) return k
    first ??= k
  }
  return first
}

/** Index of the row a key moves focus to (Arrow Up/Down, Home, End), or null
 *  for any other key or past either end. */
export function rowFocusTarget(count: number, at: number, key: string): number | null {
  if (count <= 0) return null
  const to =
    key === 'ArrowDown'
      ? at + 1
      : key === 'ArrowUp'
        ? at - 1
        : key === 'Home'
          ? 0
          : key === 'End'
            ? count - 1
            : null
  return to === null || to < 0 || to >= count ? null : to
}
