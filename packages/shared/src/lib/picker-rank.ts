/**
 * Option order while someone types in a picker. The server's search is a
 * filter (every word matches some column), not a ranking, and pickers sort
 * what comes back by label — so typing "Robert Lee" listed every Robert
 * alphabetically and the exact person landed wherever "Lee" falls. Rank the
 * label against the typed text first, then keep the label order.
 */

const norm = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, ' ').trim()

/** 0 exact · 1 label starts with the text · 2 every typed word starts a word of
 *  the label · 3 label contains the text · 4 anything else (matched elsewhere). */
export function pickerMatchTier(label: string, query: string): number {
  const q = norm(query)
  if (!q) return 4
  const l = norm(label)
  if (l === q) return 0
  if (l.startsWith(q)) return 1
  const words = l.split(/[\s,.;:()/\-_@]+/).filter(Boolean)
  if (q.split(' ').every((w) => words.some((x) => x.startsWith(w)))) return 2
  if (l.includes(q)) return 3
  return 4
}

/** Comparator: match tier first (only while there is a query), then label. */
export function compareByMatch(
  aLabel: string,
  bLabel: string,
  query: string,
  descending = false
): number {
  if (query.trim()) {
    const t = pickerMatchTier(aLabel, query) - pickerMatchTier(bLabel, query)
    if (t) return t
  }
  return descending ? bLabel.localeCompare(aLabel) : aLabel.localeCompare(bLabel)
}
