import type { QueryClient } from '@tanstack/react-query'

// `['m2m-items', junctionCollection, junctionField, parentId]` is the M2M list
// of ONE record (the record form, its pickers, every grid row's M2M cell).
// After a save the form used to invalidate the whole prefix, which refetched
// the M2M list of every grid row on screen — dozens of reads per save.

/**
 * After a write to one record: refetch the M2M lists of `parentIds` (the
 * record, plus any grid rows the same save edited) now; every other parent's
 * list is only marked stale, so it refetches the next time it is shown
 * instead of all at once.
 */
export function invalidateM2MFor(qc: QueryClient, parentIds: Iterable<string | number>): void {
  const ids = new Set<string>()
  for (const id of parentIds) ids.add(String(id))
  const ours = (key: readonly unknown[]) => key.length > 3 && ids.has(String(key[3]))
  void qc.invalidateQueries({ queryKey: ['m2m-items'], predicate: (q) => ours(q.queryKey) })
  void qc.invalidateQueries({
    queryKey: ['m2m-items'],
    predicate: (q) => !ours(q.queryKey),
    refetchType: 'none'
  })
}

/** Row ids the save edited, from the form's pending grid edits
 *  (`relation key → row id → changes`). */
export function editedRowIds(
  pendingEdits: Map<string, Map<string, Record<string, unknown>>>
): string[] {
  const out: string[] = []
  for (const rows of pendingEdits.values()) for (const id of rows.keys()) out.push(String(id))
  return out
}
