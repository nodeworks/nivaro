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
