/**
 * The Customize Columns list, one entry per column NAME.
 *
 * A worklist can carry a source extra field and a built-in column that read
 * as the same thing: the Workflows queue listed "Last State Change" twice —
 * the built-in `state_entered` (pipeline entry time, what Aging counts from)
 * and `extra.last_state_change` (the legacy column) aliased to the same words
 * (army 4 a06-5). Two identical checkboxes, only one of which shows anything
 * the viewer expects, is a trap.
 *
 * For each set of keys with the same label (case- and space-insensitive) this
 * keeps every VISIBLE one (hiding a visible column from the chooser would
 * strand it on screen) and, when none is visible, the first that is not a
 * source extra field — the built-in — else the first. Order is kept.
 */
export function dedupeChooserKeys(
  keys: string[],
  labelOf: (key: string) => string,
  visible: Set<string>
): string[] {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const groups = new Map<string, string[]>()
  for (const k of keys) {
    const n = norm(labelOf(k))
    const g = groups.get(n)
    if (g) g.push(k)
    else groups.set(n, [k])
  }
  const keep = new Set<string>()
  for (const g of groups.values()) {
    if (g.length === 1) {
      keep.add(g[0])
      continue
    }
    const shown = g.filter((k) => visible.has(k))
    if (shown.length > 0) for (const k of shown) keep.add(k)
    else keep.add(g.find((k) => !k.startsWith('extra.')) ?? g[0])
  }
  return keys.filter((k) => keep.has(k))
}
