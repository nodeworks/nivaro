/**
 * Whether the addendum the record form is showing (`viewId`, 'original' = the record itself)
 * is gone from the record's addendum list — deleted here or by someone else, or a stale
 * `?addendum=` id a reload or link carried. Judged only on a settled list (`loaded`, not
 * refetching), so a list still on its way never throws the person back to the original.
 */
export function addendumViewGone(
  viewId: string,
  addendums: ReadonlyArray<{ id: string | number }>,
  loaded: boolean
): boolean {
  if (!loaded || !viewId || viewId === 'original') return false
  return !addendums.some((a) => String(a.id) === viewId)
}
