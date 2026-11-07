/**
 * What a `$state` live notice (a record's pipeline instance started or moved)
 * does to an open worklist.
 *
 * On screen (or on the board, which holds every card): refresh the rows.
 * Off screen: offer it in the "N updates · Refresh" pill. A record that ENTERS
 * the worklist by a pipeline start — its create event arrived before its
 * instance had a state, so the server did not list it then — is off screen by
 * definition; it used to tick only the stats, and the strip said 60 while the
 * rows and pager stayed at 59 with no prompt (army 4 a06-1). The stats tick
 * either way.
 */
export function stateAspectEffect(
  visible: boolean,
  kanban: boolean
): { refresh: boolean; pill: number; stats: true } {
  return visible || kanban
    ? { refresh: true, pill: 0, stats: true }
    : { refresh: false, pill: 1, stats: true }
}

/**
 * Whether a live stats read must pull the rows along (army 7 N5): the tiles
 * counted a different total than the rows on screen, so a record entered or
 * left the worklist — the strip said 38 while the rows, pager and sentence
 * stayed at 37 behind a "2 updates · Refresh" pill for minutes. One quiet
 * re-read of the rows per stats read (already coalesced), only when the counts
 * disagree, never in a grouped / board view (those refresh their own way), and
 * never mid-selection or mid-drag (the pill stays the way in there).
 */
export function statsOutrunRows(opts: {
  liveTotal: number | null | undefined
  rowsTotal: number | null | undefined
  table: boolean
  busy: boolean
}): boolean {
  if (!opts.table || opts.busy) return false
  if (typeof opts.liveTotal !== 'number' || typeof opts.rowsTotal !== 'number') return false
  return opts.liveTotal !== opts.rowsTotal
}
