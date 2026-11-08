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

/**
 * How many "N updates · Refresh" the off-screen changes since the last stats read are
 * worth, once that read lands (army 9 b08 N-R9-3). Every write to the collection used to
 * count — other people's drafts and forecasts on records nowhere in this view — and
 * Refresh then changed nothing. Now an off-screen change only counts when the stats read
 * shows the view itself changed (its total moved) AND the rows cannot be re-read quietly
 * (mid-selection / drag); otherwise statsOutrunRows re-reads them, or nothing changed.
 */
export function offscreenPill(opts: {
  pending: number
  liveTotal: number | null | undefined
  rowsTotal: number | null | undefined
  busy: boolean
}): number {
  if (opts.pending <= 0 || !opts.busy) return 0
  if (typeof opts.liveTotal !== 'number' || typeof opts.rowsTotal !== 'number') return 0
  return opts.liveTotal !== opts.rowsTotal ? opts.pending : 0
}
